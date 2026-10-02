import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import nodeHttp from "node:http";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createArviro } from "../src/arviro.js";
import { createEmbedder } from "../src/embeddings.js";
import { createGuard } from "../src/guard.js";
import { startHttpServer } from "../src/http.js";
import { buildIndex } from "../src/indexer.js";
import { createMcpServer } from "../src/mcp.js";
import { fixtureConfig, makeFixture } from "./helpers.js";

const fixture = makeFixture();
const config = fixtureConfig(fixture);
const cli = fileURLToPath(new URL("../bin/arviro.js", import.meta.url));
let arviro;

before(async () => {
  await buildIndex(config, createEmbedder(config.embedding));
  arviro = createArviro(config);
});
after(() => {
  arviro.close();
  fixture.cleanup();
});

async function connect(scope, application = arviro, options = {}) {
  const server = createMcpServer(application, { scope, guard: createGuard(), version: "1.2.3", ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const textOf = (result) => result.content[0].text;
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const jsonHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function writeCliConfig() {
  const configPath = path.join(fixture.root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir: path.join(fixture.root, "data"),
    sources: { library: { path: fixture.library }, wiki: { path: fixture.wiki, private: true } },
    embedding: { provider: "none" },
    tools: { kiwixServe: false },
  }));
  return configPath;
}

test("the server offers two read-only tools and describes the sources", async () => {
  const client = await connect("all");
  assert.deepEqual(client.getServerVersion().name, "arviro");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["search_library", "read_document"]);
  const [search, read] = tools;
  assert.deepEqual(search.inputSchema.properties.source.enum, ["library", "wiki", "wikipedia", "wikivoyage", "maps"]);
  assert.match(search.inputSchema.properties.source.description, /- library: Test library/);
  assert.deepEqual(search.inputSchema.required, ["query", "source"]);
  assert.deepEqual(search.inputSchema.properties.limit, { description: "Maximum number of results (default 5, at most 10).", type: "integer", minimum: 1, maximum: 1000 });
  assert.equal(search.inputSchema.properties.pathPrefix.type, "string");
  assert.deepEqual(read.inputSchema.properties.source.enum, ["library", "wiki", "wikipedia", "wikivoyage"]);
  assert.equal(search.annotations.readOnlyHint, true);
  await client.close();
});

test("search and read work through the protocol", async () => {
  const client = await connect("all");
  const found = JSON.parse(textOf(await client.callTool({ name: "search_library", arguments: { source: "library", query: "How long should I cool a burn?" } })));
  assert.equal(found.results[0].read.path, "manuals/first-aid.md");
  const read = await client.callTool({ name: "read_document", arguments: found.results[0].read });
  assert.match(textOf(read), /11: Cool a burn with lukewarm running water/);
  await client.close();
});

test("optional parameters may be numbers as text, too large, null or empty", async () => {
  const client = await connect("all");
  // Every call has its own question, because an identical call is answered from the repeat guard.
  const call = async (query, extra) => {
    const result = await client.callTool({ name: "search_library", arguments: { source: "library", query, ...extra } });
    assert.notEqual(result.isError, true, JSON.stringify(extra));
    return JSON.parse(textOf(result));
  };
  assert.equal((await call("water storm candles bandages radio", { limit: "1" })).results.length, 1);
  assert.ok((await call("water storm candles bandages", { limit: 50 })).results.length <= 10);
  assert.ok((await call("water storm candles", { limit: null, pathPrefix: null })).results.length > 1);
  assert.ok((await call("water storm", { limit: "", pathPrefix: "" })).results.length > 1);
  const read = await client.callTool({ name: "read_document", arguments: { source: "library", path: "manuals/water.txt", offset: "", limit: null } });
  assert.match(textOf(read), /1: Drinking water/);
  await client.close();
});

test("mistakes come back as errors that explain what to do", async () => {
  const client = await connect("all");
  const missing = await client.callTool({ name: "read_document", arguments: { source: "library", path: "manuals/nope.md" } });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /read_document could not do this: This file does not exist\. Use a relative path returned by search_library\./);
  const repeated = await client.callTool({ name: "read_document", arguments: { source: "library", path: "manuals/nope.md" } });
  assert.match(textOf(repeated), /^NOTE: this exact call failed moments ago/);
  const invalid = await client.callTool({ name: "search_library", arguments: { source: "nowhere", query: "water" } });
  assert.equal(invalid.isError, true);
  await client.close();
});

test("unexpected failures are logged, and the model only hears that something went wrong", async () => {
  const logged = [];
  const failing = { sources: (scope) => arviro.sources(scope), search: async () => { throw new Error("ENOENT: /home/someone/secret/index.sqlite"); } };
  const client = await connect("all", failing, { log: (message) => logged.push(message) });
  const result = await client.callTool({ name: "search_library", arguments: { source: "library", query: "water" } });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), "search_library failed because of an internal error. Do not retry; tell the user that the library tool has a problem.");
  assert.match(logged[0], /ENOENT: \/home\/someone\/secret/);
  await client.close();
});

test("the public scope does not expose private sources", async () => {
  const client = await connect("public");
  const { tools } = await client.listTools();
  assert.deepEqual(tools[0].inputSchema.properties.source.enum, ["library", "wikipedia", "wikivoyage", "maps"]);
  assert.doesNotMatch(JSON.stringify(tools), /Private notes/);
  const refused = await client.callTool({ name: "search_library", arguments: { source: "wiki", query: "family bakery" } });
  assert.equal(refused.isError, true);
  const read = await client.callTool({ name: "read_document", arguments: { source: "wiki", path: "family/grandmother.md" } });
  assert.equal(read.isError, true);
  assert.doesNotMatch(textOf(read), /Anna/);
  await client.close();
});

test("HTTP: both endpoints, statelessly", async (t) => {
  const http = await startHttpServer(arviro, { guard: createGuard(), version: "1.2.3" });
  t.after(() => http.close());

  const health = await (await fetch(`${http.url}/health`)).json();
  assert.equal(health.ok, true);

  for (const [endpoint, sources] of [["/mcp", 5], ["/public/mcp", 4]]) {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${http.url}${endpoint}`)));
    const { tools } = await client.listTools();
    assert.equal(tools[0].inputSchema.properties.source.enum.length, sources);
    const found = JSON.parse(textOf(await client.callTool({ name: "search_library", arguments: { source: "library", query: "drinking water" } })));
    assert.equal(found.results[0].read.path, "manuals/water.txt");
    await client.close();
  }

  const get = await fetch(`${http.url}/mcp`);
  assert.equal(get.status, 405);
  const unknown = await fetch(`${http.url}/elsewhere`, { method: "POST", body: "{}" });
  assert.equal(unknown.status, 404);
  const garbage = await fetch(`${http.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assert.equal(garbage.status, 400);
});

test("HTTP: requests from web pages and foreign host names are refused", async (t) => {
  const http = await startHttpServer(arviro, { guard: createGuard(), version: "1.2.3" });
  t.after(() => http.close());
  const body = JSON.stringify(listTools);

  const crossSite = await fetch(`${http.url}/mcp`, { method: "POST", headers: { ...jsonHeaders, origin: "https://evil.example" }, body });
  assert.equal(crossSite.status, 403);

  // A DNS-rebinding request carries the attacker's host name.
  const rebound = await new Promise((resolve, reject) => {
    const request = nodeHttp.request({ host: "127.0.0.1", port: http.port, path: "/mcp", method: "POST", headers: { ...jsonHeaders, host: "evil.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end(body);
  });
  assert.equal(rebound, 403);
});

test("HTTP: each endpoint has its own token, and the public token does not open the private sources", async (t) => {
  const secured = createArviro(fixtureConfig(fixture, { server: { port: 0, authToken: "full-token", publicToken: "public-token" } }));
  const http = await startHttpServer(secured, { guard: createGuard(), version: "1.2.3" });
  t.after(async () => { await http.close(); secured.close(); });
  const status = async (endpoint, token) => (await fetch(`${http.url}${endpoint}`, {
    method: "POST",
    headers: { ...jsonHeaders, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(listTools),
  })).status;
  assert.equal(await status("/mcp", null), 401);
  assert.equal(await status("/mcp", "public-token"), 401);
  assert.equal(await status("/mcp", "full-token"), 200);
  assert.equal(await status("/public/mcp", null), 401);
  assert.equal(await status("/public/mcp", "wrong"), 401);
  assert.equal(await status("/public/mcp", "public-token"), 200);
  assert.equal(await status("/public/mcp", "full-token"), 200);
  // Another spelling of the same path does not get around the check.
  assert.equal(await status("/public/%2e%2e/mcp", "public-token"), 401);
});

test("HTTP: with only a token for all sources, the public endpoint stays open", async (t) => {
  const secured = createArviro(fixtureConfig(fixture, { server: { port: 0, authToken: "full-token" } }));
  const http = await startHttpServer(secured, { guard: createGuard(), version: "1.2.3" });
  t.after(async () => { await http.close(); secured.close(); });
  const post = (endpoint) => fetch(`${http.url}${endpoint}`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(listTools) });
  assert.equal((await post("/mcp")).status, 401);
  const open = await post("/public/mcp");
  assert.equal(open.status, 200);
  const [search] = (await open.json()).result.tools;
  assert.deepEqual(search.inputSchema.properties.source.enum, ["library", "wikipedia", "wikivoyage", "maps"]);
});

test("HTTP: the call budget is counted per connection", async (t) => {
  const http = await startHttpServer(arviro, { guard: createGuard({ maxCallsPerWindow: 2 }), version: "1.2.3" });
  t.after(() => http.close());
  // Each agent keeps one connection open, the way a chat application does during one turn.
  const agents = [new nodeHttp.Agent({ keepAlive: true, maxSockets: 1 }), new nodeHttp.Agent({ keepAlive: true, maxSockets: 1 })];
  t.after(() => agents.forEach((agent) => agent.destroy()));
  const ask = (agent, query) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_library", arguments: { source: "library", query } } });
    const request = nodeHttp.request({ host: "127.0.0.1", port: http.port, path: "/public/mcp", method: "POST", agent, headers: jsonHeaders }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve(JSON.parse(text).result.content[0].text));
    });
    request.on("error", reject);
    request.end(body);
  });
  await ask(agents[0], "drinking water");
  await ask(agents[0], "storm shutters");
  assert.match(await ask(agents[0], "candles matches"), /^Too many library calls/);
  assert.match(await ask(agents[1], "candles matches"), /"results"/);
});

test("stdio: the command line server answers a client", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "stdio", "--public", "--config", writeCliConfig()], stderr: "ignore" }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools[0].inputSchema.properties.source.enum, ["library"]);
  const found = JSON.parse(textOf(await client.callTool({ name: "search_library", arguments: { source: "library", query: "bandages and gloves" } })));
  assert.equal(found.results[0].read.path, "manuals/first-aid.md");
  await client.close();
});

test("stdio: the server stops when the client closes its input", async () => {
  const child = spawn(process.execPath, [cli, "stdio", "--config", writeCliConfig()], { stdio: ["pipe", "ignore", "ignore"] });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 5000))]);
  if (code === "still running") child.kill("SIGKILL");
  assert.equal(code, 0);
});
