// MCP over Streamable HTTP, for clients such as Open WebUI.
// The server is stateless: every POST is handled on its own, and replies are plain JSON.
import crypto from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, SERVER_NAME } from "./mcp.js";

const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

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
 * Endpoints: POST /mcp (all sources), POST /public/mcp (public sources only), GET /health.
 * `server.authToken` protects /mcp and `server.publicToken` protects /public/mcp; the token for
 * all sources is also accepted on the public endpoint.
 * @returns {Promise<{ url: string, port: number, close(): Promise<void> }>}
 */
export function startHttpServer(arviro, { guard, version, log = () => {} }) {
  const { server: settings } = arviro.config;
  const loopbackOnly = LOOPBACK.has(settings.host);
  const allowedHosts = new Set(settings.allowedHosts.map((host) => host.toLowerCase()));
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

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      // A web page in a browser must not be able to reach a local server (DNS rebinding, cross-site requests).
      const host = String(req.headers.host || "").toLowerCase();
      if ((loopbackOnly || settings.allowedHosts.length) && !allowedHosts.has(host)) return rpcError(res, 403, "Host not allowed.");
      if (req.headers.origin && !settings.allowedOrigins.includes(req.headers.origin)) return rpcError(res, 403, "Origin not allowed.");

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, name: SERVER_NAME, version, endpoints: { all: "/mcp", public: "/public/mcp" } });
      }
      const scope = url.pathname === "/mcp" ? "all" : url.pathname === "/public/mcp" ? "public" : null;
      if (!scope) return rpcError(res, 404, "Not found. MCP endpoints: /mcp and /public/mcp.");
      if (!authorized(req, scope)) return rpcError(res, 401, "Missing or wrong bearer token.", { "www-authenticate": "Bearer" });
      if (req.method !== "POST") return rpcError(res, 405, "Method not allowed: this server only accepts POST.", { allow: "POST" });

      let body;
      try { body = await readJson(req); } catch (error) { return rpcError(res, 400, `Invalid request body: ${error.message}`, {}, -32700); }
      const mcp = createMcpServer(arviro, { scope, guard, version, log, sessionKey: `${scope}:${connectionId(req.socket)}` });
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
        close: () => new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}
