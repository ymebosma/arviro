// MCP over Streamable HTTP, for clients such as Open WebUI.
// The server is stateless: every POST is handled on its own, and replies are plain JSON.
import crypto from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ConfigError, createAdmin } from "./admin.js";
import { createMcpServer, SERVER_NAME } from "./mcp.js";
import { UserInputError } from "./text.js";

const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store", ...headers });
  res.end(payload);
}

function rpcError(res, status, message, headers = {}, code = -32000) {
  send(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function tokenMatches(header, token) {
  const given = Buffer.from(String(header || "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Endpoints: POST /mcp (all sources), POST /public/mcp (public sources only), GET /health,
 * and the admin page under /admin/ (see admin.js) for connections from this computer.
 * `server.authToken` protects /mcp and the admin API; `server.publicToken` protects /public/mcp; the token for
 * all sources is also accepted on the public endpoint.
 * @param {object} [options.admin]  `fetchImpl` and `platform` for the admin page's checks (tests)
 * @returns {Promise<{ url: string, port: number, replace(next): void, close(): Promise<void> }>}
 */
export function startHttpServer(arviro, { guard, version, log = () => {}, admin: adminOptions = {} }) {
  let current = arviro;
  const { server: settings } = arviro.config;
  const loopbackOnly = LOOPBACK.has(settings.host);
  const allowedHosts = new Set(settings.allowedHosts.map((host) => host.toLowerCase()));
  const replace = (next) => {
    const previous = current;
    current = next;
    if (previous !== next) previous.close();
  };
  const admin = settings.admin ? createAdmin({ getArviro: () => current, replace, guard, version, log, ...adminOptions }) : null;
  // One HTTP connection is one guard session. Clients keep a connection open during a chat turn,
  // so a model that loops is slowed down without affecting other users.
  const connections = new WeakMap();
  let connectionCount = 0;
  const connectionId = (socket) => {
    if (!connections.has(socket)) connections.set(socket, connectionCount += 1);
    return connections.get(socket);
  };

  function authorized(req, scope) {
    const header = req.headers.authorization;
    if (scope === "all") return !settings.authToken || tokenMatches(header, settings.authToken);
    if (!settings.publicToken) return true;
    return tokenMatches(header, settings.publicToken) || Boolean(settings.authToken && tokenMatches(header, settings.authToken));
  }

  /** The admin page is for the owner: from this computer, or with the token of /mcp when one is set. */
  function adminAllowed(req) {
    if (!admin) return false;
    return LOOPBACK_ADDRESSES.has(req.socket.remoteAddress) || Boolean(settings.authToken);
  }

  async function handleAdmin(req, res, url) {
    if (!adminAllowed(req)) return rpcError(res, 404, "Not found.");
    const rest = url.pathname.slice("/admin/".length);
    if (!rest.startsWith("api/")) {
      if (req.method !== "GET") return rpcError(res, 405, "Method not allowed.", { allow: "GET" });
      const file = admin.staticFile(rest);
      if (!file) return rpcError(res, 404, "Not found.");
      res.writeHead(200, { "content-type": file.type, "content-length": file.body.length, "cache-control": "no-store", "content-security-policy": "default-src 'self'; img-src 'self' data:", "x-content-type-options": "nosniff" });
      return res.end(file.body);
    }
    if (settings.authToken && !tokenMatches(req.headers.authorization, settings.authToken)) return send(res, 401, { error: "This server has a token (server.authToken); enter it to use the admin page." }, { "www-authenticate": "Bearer" });
    const route = rest.slice("api/".length);
    let body = null;
    if (req.method === "POST") {
      // A browser can only send JSON cross-site after a CORS preflight, which this server never answers.
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "Send JSON." });
      try { body = await readJson(req); } catch (error) { return send(res, 400, { error: `Invalid request body: ${error.message}` }); }
    } else if (req.method !== "GET") {
      return send(res, 405, { error: "Method not allowed." }, { allow: "GET, POST" });
    }
    try {
      if (req.method === "POST" && route === "chat") return await streamAdmin(req, res, route, body);
      const result = await admin.api(req.method, route, url.searchParams, body);
      return send(res, result.status, result.body);
    } catch (error) {
      if (error instanceof UserInputError || error instanceof ConfigError) return send(res, 400, { error: error.message });
      throw error;
    }
  }

  /** Events of a streaming admin call, one JSON object per line. A closed connection stops the work. */
  async function streamAdmin(req, res, route, body) {
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const events = admin.stream(route, body, controller.signal);
    let started = false;
    try {
      for await (const event of events) {
        if (!started) { res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" }); started = true; }
        res.write(`${JSON.stringify(event)}\n`);
      }
      if (!started) res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
      res.end(`${JSON.stringify({ type: "done" })}\n`);
    } catch (error) {
      if (controller.signal.aborted) return res.end();
      const safe = error instanceof UserInputError || error instanceof ConfigError;
      if (!safe) log(`chat failed: ${error.stack || error.message}`);
      const message = safe ? error.message : `The chat failed: ${error.message}`;
      if (!started) return send(res, safe ? 400 : 502, { error: message });
      res.end(`${JSON.stringify({ type: "error", message })}\n`);
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      // A web page in a browser must not be able to reach a local server (DNS rebinding, cross-site requests).
      // The server's own pages are the exception: their Origin is the Host they were loaded from.
      const host = String(req.headers.host || "").toLowerCase();
      if ((loopbackOnly || settings.allowedHosts.length) && !allowedHosts.has(host)) return rpcError(res, 403, "Host not allowed.");
      const origin = req.headers.origin;
      if (origin && !settings.allowedOrigins.includes(origin) && !(origin.toLowerCase() === `http://${host}` && allowedHosts.has(host))) return rpcError(res, 403, "Origin not allowed.");

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, name: SERVER_NAME, version, endpoints: { all: "/mcp", public: "/public/mcp", ...(adminAllowed(req) ? { admin: "/admin/" } : {}) } });
      }
      if (url.pathname === "/admin/" || url.pathname.startsWith("/admin/")) return handleAdmin(req, res, url);
      if (url.pathname === "/" || url.pathname === "/admin") {
        if (!adminAllowed(req)) return rpcError(res, 404, "Not found. MCP endpoints: /mcp and /public/mcp.");
        res.writeHead(302, { location: "/admin/" });
        return res.end();
      }
      const scope = url.pathname === "/mcp" ? "all" : url.pathname === "/public/mcp" ? "public" : null;
      if (!scope) return rpcError(res, 404, "Not found. MCP endpoints: /mcp and /public/mcp.");
      if (!authorized(req, scope)) return rpcError(res, 401, "Missing or wrong bearer token.", { "www-authenticate": "Bearer" });
      if (req.method !== "POST") return rpcError(res, 405, "Method not allowed: this server only accepts POST.", { allow: "POST" });
      if (!current.sources(scope).length) return rpcError(res, 503, "No sources are configured yet. The owner can add some on the admin page.");

      let body;
      try { body = await readJson(req); } catch (error) { return rpcError(res, 400, `Invalid request body: ${error.message}`, {}, -32700); }
      const mcp = createMcpServer(current, { scope, guard, version, log, sessionKey: `${scope}:${connectionId(req.socket)}` });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close().catch(() => {});
        mcp.close().catch(() => {});
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      log(`request failed: ${error.stack || error.message}`);
      if (!res.headersSent) rpcError(res, 500, "Internal server error.", {}, -32603);
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.host, () => {
      const { port } = server.address();
      for (const name of ["127.0.0.1", "localhost", "[::1]"]) allowedHosts.add(`${name}:${port}`);
      if (!loopbackOnly && !settings.authToken) log(`warning: listening on ${settings.host} without server.authToken; anyone who can reach this port can search every source`);
      const shownHost = settings.host.includes(":") ? `[${settings.host}]` : settings.host;
      resolve({
        url: `http://${shownHost}:${port}`,
        port,
        replace,
        current: () => current,
        close: () => new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}
