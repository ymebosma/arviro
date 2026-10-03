import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test, { after, before } from "node:test";
import { createArviro } from "../src/arviro.js";
import { listFolders } from "../src/admin.js";
import { CURATED, parseCatalogueFeed, parseGeofabrikIndex, regionIdFor } from "../src/catalogue.js";
import { loadConfig } from "../src/config.js";
import { addMapDownload, addZimDownload, homeRelative, readRawConfig, removeDownload, setDocumentSource, writeRawConfig } from "../src/configfile.js";
import { createGuard } from "../src/guard.js";
import { startHttpServer } from "../src/http.js";
import { adviceFor, checkEnvironment, hasModel } from "../src/setup.js";
import { makeFixture, startFakeDownloads, WIKIPEDIA_BOOK } from "./helpers.js";

const fixture = makeFixture();
const remote = startFakeDownloads();
const configPath = path.join(fixture.root, "admin-config.json");
let server;
let ollama;

/**
 * A stand-in for Ollama: /api/tags lists the models, /api/pull streams progress and then adds the model,
 * and /api/chat answers a user message with a search_library call and a tool result with a sentence.
 */
function startFakeOllama() {
  const models = ["chatty:latest"];
  const chats = [];
  const node = http.createServer((req, res) => {
    if (req.url === "/api/tags") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ models: models.map((name) => ({ name })) })); }
    if (req.url === "/api/chat") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const request = JSON.parse(body);
        chats.push(request);
        if (request.model === "no-tools") { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "registry.ollama.ai/library/no-tools does not support tools" })); }
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const last = request.messages.at(-1);
        const line = (message, done = false) => res.write(`${JSON.stringify({ model: request.model, message, done })}\n`);
        // A "slow" model thinks forever: the connection stays open until the client gives up.
        if (request.model === "slow") return line({ role: "assistant", content: "", thinking: "Hmm" });
        // A "looping" model thinks until num_predict cuts it off, without any answer.
        if (request.model === "looping") { line({ role: "assistant", content: "", thinking: "Wait, should I? No. Wait, should I? No." }); res.write(`${JSON.stringify({ model: request.model, message: { role: "assistant", content: "" }, done: true, done_reason: "length" })}\n`); return res.end(); }
        if (last.role === "user") {
          line({ role: "assistant", content: "", thinking: "The user asks about " });
          line({ role: "assistant", content: "", thinking: "the library; I should search." });
          line({ role: "assistant", content: "", tool_calls: [{ function: { name: "search_library", arguments: { source: "library", query: last.content } } }] });
          line({ role: "assistant", content: "" }, true);
        } else {
          line({ role: "assistant", content: "Based on the library: " });
          line({ role: "assistant", content: `${last.content.slice(0, 40)}` });
          line({ role: "assistant", content: "" }, true);
        }
        res.end();
      });
      return;
    }
    if (req.url === "/api/pull") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const { model } = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(`${JSON.stringify({ status: "pulling manifest" })}\n`);
        res.write(`${JSON.stringify({ status: "pulling layer", digest: "sha256:abc", total: 1000, completed: 500 })}\n`);
        res.write(`${JSON.stringify({ status: "pulling layer", digest: "sha256:abc", total: 1000, completed: 1000 })}\n`);
        res.write(`${JSON.stringify({ status: "success" })}\n`);
        models.push(`${model}:latest`);
        res.end();
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return { node, models, chats, start: () => new Promise((resolve) => node.listen(0, "127.0.0.1", resolve)), url: () => `http://127.0.0.1:${node.address().port}` };
}

/** Send a chat turn and collect the streamed events. */
async function chatTurn(base, body, headers = {}) {
  const response = await fetch(`${base}/admin/api/chat`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await response.text();
  const events = response.headers.get("content-type")?.includes("ndjson") ? text.trim().split("\n").map((line) => JSON.parse(line)) : [JSON.parse(text)];
  return { status: response.status, events };
}

function writeConfig(extra = {}) {
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir: path.join(fixture.root, "admin-data"),
    sources: { library: { path: fixture.library, description: "Test library" }, wiki: { path: fixture.wiki, description: "Private notes", private: true } },
    kiwix: { zimDir: fixture.zimDir },
    maps: { regions: { test: path.join(fixture.root, "maps/test.osm.pbf") } },
    embedding: { provider: "none" },
    server: { port: 0 },
    tools: { osmium: path.join(fixture.root, "bin/osmium"), pdftotext: path.join(fixture.root, "bin/pdftotext"), kiwixServe: false },
    library: { kiwixCatalog: `${remote.url}/catalog/v2`, geofabrikIndex: `${remote.url}/geofabrik/index-v1-nogeom.json`, downloads: [] },
    ...extra,
  }, null, 2));
}

async function startServer(serverOptions = {}, extra = {}) {
  writeConfig({ server: { port: 0, ...serverOptions }, ...extra });
  const arviro = createArviro(loadConfig(configPath), {});
  return startHttpServer(arviro, { guard: createGuard(), version: "9.9.9", admin: { platform: "darwin" } });
}

before(async () => {
  await remote.start();
  ollama = startFakeOllama();
  await ollama.start();
  server = await startServer();
});
after(async () => {
  await server.close();
  await remote.close();
  ollama.node.close();
  ollama.node.closeAllConnections();
  fixture.cleanup();
});

const api = async (route, { method = "GET", body, headers = {}, base = server.url } = {}) => {
  const response = await fetch(`${base}/admin/api/${route}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};
const sourcesOnMcp = async (scope = "all") => {
  const response = await fetch(`${server.url}/${scope === "public" ? "public/mcp" : "mcp"}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const { result } = await response.json();
  return result.tools[0].inputSchema.properties.source.enum;
};
const waitForJob = async () => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const { body } = await api("jobs");
    if (body.job.status !== "running") return body.job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the job did not finish");
};

test("the page, the redirect and the health endpoint", async () => {
  const page = await fetch(`${server.url}/admin/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await page.text(), /<title>Arviro<\/title>/);
  assert.equal((await fetch(`${server.url}/admin/app.js`)).status, 200);
  assert.equal((await fetch(`${server.url}/admin/style.css`)).status, 200);
  assert.equal((await fetch(`${server.url}/admin/markdown.js`)).status, 200);
  assert.equal((await fetch(`${server.url}/admin/../package.json`)).status, 404);
  assert.equal((await fetch(`${server.url}/admin/nope.html`)).status, 404);
  const root = await fetch(`${server.url}/`, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/admin/");
  assert.equal((await (await fetch(`${server.url}/health`)).json()).endpoints.admin, "/admin/");
  assert.equal((await fetch(`${server.url}/public/admin/`)).status, 404);
});

test("the overview checks the environment and lists the library", async () => {
  const { status, body } = await api("overview");
  assert.equal(status, 200);
  assert.equal(body.version, "9.9.9");
  assert.equal(body.config.path, configPath);
  assert.equal(body.config.missing, false);
  const byId = Object.fromEntries(body.checks.map((check) => [check.id, check]));
  assert.equal(byId.config.ok, true);
  assert.equal(byId.sources.ok, true);
  assert.equal(byId["kiwix-serve"].ok, false);
  assert.match(byId["kiwix-serve"].advice.url, /kiwix-tools/);
  assert.equal(byId.pdftotext.ok, true);
  assert.equal(byId.embeddings.detail, "disabled; only literal matches are found");
  assert.equal(byId.index.ok, false);
  assert.equal(byId.index.fix, "index");
  assert.deepEqual(body.sources.map((source) => source.id), ["library", "wiki", "wikipedia", "wikivoyage", "maps"]);
  assert.ok(body.library.some((row) => row.id === "wikipedia_nl_all_nopic" && row.managed === false));
  assert.equal(body.defaults.zimDir, fixture.zimDir);
  assert.equal(body.job, null);
});

test("a document folder is added to the configuration file and served at once", async () => {
  const folder = path.join(fixture.root, "outside");
  const added = await api("sources", { method: "POST", body: { id: "extra", path: folder, description: "Extra documents", private: true } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const raw = readRawConfig(configPath);
  assert.deepEqual(raw.sources.extra, { path: folder, description: "Extra documents", private: true });
  assert.equal(raw.embedding.provider, "none", "other settings are kept");
  assert.ok((await sourcesOnMcp()).includes("extra"));
  assert.ok(!(await sourcesOnMcp("public")).includes("extra"), "a private source stays off the public endpoint");

  const missing = await api("sources", { method: "POST", body: { id: "nope", path: path.join(fixture.root, "does-not-exist") } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /does not exist/);
  const badId = await api("sources", { method: "POST", body: { id: "Bad Id", path: folder } });
  assert.equal(badId.status, 400);

  const removed = await api("sources/remove", { method: "POST", body: { id: "extra" } });
  assert.equal(removed.status, 200);
  assert.equal(readRawConfig(configPath).sources.extra, undefined);
  assert.ok(!(await sourcesOnMcp()).includes("extra"));
});

test("downloads are added from the catalogues and removed again", async () => {
  const zim = await api("downloads", { method: "POST", body: { zim: "wikipedia_nl_all_nopic" } });
  assert.equal(zim.status, 200, JSON.stringify(zim.body));
  assert.deepEqual(zim.body.downloads, [{ id: "wikipedia_nl_all_nopic", kind: "zim" }]);
  const map = await api("downloads", { method: "POST", body: { map: "testland", url: `${remote.url}/europe/testland-latest.osm.pbf` } });
  assert.equal(map.status, 200, JSON.stringify(map.body));
  const raw = readRawConfig(configPath);
  assert.deepEqual(raw.library.downloads, [{ zim: "wikipedia_nl_all_nopic" }, { map: "testland", url: `${remote.url}/europe/testland-latest.osm.pbf` }]);
  assert.equal(raw.maps.regions.testland, path.join(fixture.root, "admin-data", "maps", "testland-latest.osm.pbf"));
  assert.ok(map.body.library.some((row) => row.id === "testland" && row.exists === false));
  assert.equal((await api("downloads", { method: "POST", body: { map: "x", url: "https://example.org/not-a-map.zip" } })).status, 400);
  assert.equal((await api("downloads", { method: "POST", body: {} })).status, 400);

  const gone = await api("downloads/remove", { method: "POST", body: { id: "testland" } });
  assert.equal(gone.status, 200);
  const after = readRawConfig(configPath);
  assert.deepEqual(after.library.downloads, [{ zim: "wikipedia_nl_all_nopic" }]);
  assert.equal(after.maps.regions.testland, undefined, "a region without a file is removed with its download");
  assert.equal(after.maps.regions.test, path.join(fixture.root, "maps/test.osm.pbf"));
});

test("the catalogue offers curated entries and search results", async () => {
  const curatedOnly = await api("catalogue?kind=zim");
  assert.equal(curatedOnly.status, 200);
  assert.ok(curatedOnly.body.curated.every((item) => item.kind === "zim"));
  assert.deepEqual(curatedOnly.body.results, [], "without a search only the curated choices are shown");
  const zim = await api("catalogue?kind=zim&query=wikipedia");
  // The name to add is the series of the file, flavour included; the catalogue's own <name> leaves it out.
  assert.deepEqual(zim.body.results.map((book) => book.name), ["wikipedia_nl_all_maxi", "wikipedia_nl_all_nopic"]);
  const nopic = zim.body.results[1];
  assert.equal(nopic.edition, "2026-09");
  assert.equal(nopic.bytes, remote.ZIM_BYTES.length);
  assert.equal(nopic.summary, "Dutch Wikipedia & more (nopic)", "entities are decoded");
  assert.deepEqual((await api("catalogue?kind=zim&query=zzz")).body.results, []);
  assert.deepEqual((await api("catalogue?kind=map")).body.results, []);
  const maps = await api("catalogue?kind=map&query=test");
  assert.deepEqual(maps.body.results.map((region) => [region.id, region.suggestedId]), [["europe/testland", "testland"]]);
  assert.equal((await api("catalogue?kind=map&query=europe")).body.results.length, 2, "a region without a pbf URL is left out");

  const feed = parseCatalogueFeed(remote.catalogFeed("https://download.example"));
  assert.equal(feed[0].title, "Wikipedia");
  assert.equal(feed[0].language, "nld");
  assert.equal(feed[0].flavour, "maxi");
  assert.equal(regionIdFor("europe/great-britain"), "great-britain");
  assert.deepEqual(parseGeofabrikIndex({ features: [{ properties: { id: "a", urls: { pbf: "u" } } }, { properties: {} }] }), [{ id: "a", name: "a", parent: null, url: "u" }]);
  assert.ok(CURATED.some((item) => item.kind === "map" && item.id === "nl"));
});

test("jobs run one at a time: the index, a library check and a library update", async () => {
  const started = await api("jobs", { method: "POST", body: { job: "index" } });
  assert.equal(started.status, 202);
  assert.equal(started.body.job.name, "index");
  const busy = await api("jobs", { method: "POST", body: { job: "index" } });
  assert.equal(busy.status, 400);
  assert.match(busy.body.error, /still running/);
  const finished = await waitForJob();
  assert.equal(finished.status, "done", finished.error);
  assert.ok(finished.result.documents.indexed > 0);
  assert.equal((await api("overview")).body.index.exists, true);

  await api("jobs", { method: "POST", body: { job: "library-check" } });
  const checked = await waitForJob();
  assert.equal(checked.status, "done", checked.error);
  assert.equal(checked.result[0].verdict, "newer");

  await api("jobs", { method: "POST", body: { job: "library-update", names: ["wikipedia_nl_all_nopic"] } });
  const updated = await waitForJob();
  assert.equal(updated.status, "done", updated.error);
  assert.equal(updated.result.downloaded, 1);
  assert.ok(updated.lines.some((line) => /downloaded wikipedia_nl_all_nopic_2026-09\.zim/.test(line)), updated.lines.join("\n"));
  assert.ok(fs.existsSync(path.join(fixture.zimDir, `${remote.NEW_WIKIPEDIA}.zim`)));
  assert.ok(!fs.existsSync(path.join(fixture.zimDir, `${WIKIPEDIA_BOOK}.zim`)), "the old edition is removed");
  assert.ok((await api("overview")).body.sources.find((source) => source.id === "wikipedia").books.includes(remote.NEW_WIKIPEDIA), "the server now serves the new edition");
  assert.equal((await api("jobs", { method: "POST", body: { job: "dance" } })).status, 400);
}, { timeout: 60_000 });

test("the folder browser lists folders only, without hidden ones", async () => {
  const { status, body } = await api(`folders?path=${encodeURIComponent(fixture.library)}`);
  assert.equal(status, 200);
  assert.deepEqual(body.folders.map((folder) => folder.name), ["guides", "manuals", "vendor", "web"]);
  assert.equal(body.parent, fixture.root);
  assert.equal((await api(`folders?path=${encodeURIComponent(path.join(fixture.root, "nope"))}`)).status, 400);
  assert.equal(listFolders("~").path, listFolders("").path);
});

test("cross-site requests are refused and the page's own origin is accepted", async () => {
  const foreign = await api("jobs", { method: "POST", body: { job: "index" }, headers: { origin: "http://evil.example" } });
  assert.equal(foreign.status, 403);
  const own = await api("overview", { headers: { origin: server.url } });
  assert.equal(own.status, 200);
  const form = await fetch(`${server.url}/admin/api/jobs`, { method: "POST", headers: { "content-type": "text/plain" }, body: '{"job":"index"}' });
  assert.equal(form.status, 415);
  assert.equal((await fetch(`${server.url}/admin/api/overview`, { method: "DELETE" })).status, 405);
  assert.equal((await api("nope")).status, 400);
});

test("with a token the admin API needs it, and the page can be switched off", async () => {
  const other = await startServer({ authToken: "secret-token" });
  try {
    const page = await fetch(`${other.url}/admin/`);
    assert.equal(page.status, 200, "the page itself has no secrets");
    const refused = await api("overview", { base: other.url });
    assert.equal(refused.status, 401);
    assert.match(refused.body.error, /server\.authToken/);
    const allowed = await api("overview", { base: other.url, headers: { authorization: "Bearer secret-token" } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.config.server.hasToken, true);
  } finally {
    await other.close();
  }
  const off = await startServer({ admin: false });
  try {
    assert.equal((await fetch(`${off.url}/admin/`)).status, 404);
    assert.equal((await fetch(`${off.url}/`)).status, 404);
    assert.equal((await (await fetch(`${off.url}/health`)).json()).endpoints.admin, undefined);
  } finally {
    await off.close();
  }
  writeConfig();
});

test("Ollama is checked and a missing model can be pulled from the page", async () => {
  const other = await startServer({}, { embedding: { provider: "ollama", url: ollama.url(), model: "test-embed" } });
  try {
    const before = await api("overview", { base: other.url });
    const model = before.body.checks.find((check) => check.id === "embedding-model");
    assert.equal(model.ok, false);
    assert.equal(model.fix, "ollama-pull");
    assert.equal(model.advice.command, "ollama pull test-embed");
    assert.equal(before.body.checks.find((check) => check.id === "ollama").ok, true);
    await api("jobs", { method: "POST", body: { job: "ollama-pull" }, base: other.url });
    let job;
    do { job = (await api("jobs", { base: other.url })).body.job; await new Promise((resolve) => setTimeout(resolve, 50)); } while (job.status === "running");
    assert.equal(job.status, "done", job.error);
    assert.ok(job.lines.some((line) => /pulling layer: 50%/.test(line)), job.lines.join("\n"));
    assert.ok(job.lines.some((line) => /100%/.test(line)));
    const after = await api("overview", { base: other.url });
    assert.equal(after.body.checks.find((check) => check.id === "embedding-model").ok, true);
  } finally {
    await other.close();
  }
  writeConfig();
});

test("the chat answers with the library tools through Ollama", async () => {
  fs.writeFileSync(path.join(fixture.root, "prompt.md"), "You are the test assistant.\n");
  const other = await startServer({}, { chat: { url: ollama.url(), model: "chatty:latest", systemPrompt: path.join(fixture.root, "prompt.md") } });
  try {
    const models = await api("chat/models", { base: other.url });
    assert.deepEqual(models.body.models, ["chatty:latest"], "embedding models are left out");
    assert.equal(models.body.default, "chatty:latest");

    ollama.chats.length = 0;
    const { status, events } = await chatTurn(other.url, { messages: [{ role: "user", content: "How long should I cool a burn?" }] });
    assert.equal(status, 200);
    const types = events.map((event) => event.type);
    assert.deepEqual(types, ["thinking", "thinking", "message", "tool", "toolResult", "message", "token", "token", "message", "done"], JSON.stringify(events));
    assert.equal(events.filter((event) => event.type === "thinking").map((event) => event.text).join(""), "The user asks about the library; I should search.");
    const tool = events.find((event) => event.type === "tool");
    assert.deepEqual(tool, { type: "tool", name: "search_library", args: { source: "library", query: "How long should I cool a burn?" } });
    const result = events.find((event) => event.type === "toolResult");
    assert.match(result.text, /manuals\/first-aid\.md/);
    assert.match(result.text, /lukewarm running water/);
    const answer = events.filter((event) => event.type === "token").map((event) => event.text).join("");
    assert.match(answer, /^Based on the library: /);
    const history = events.filter((event) => event.type === "message").map((event) => event.message);
    assert.equal(history[0].tool_calls[0].function.name, "search_library");
    assert.equal(history[1].role, "tool");
    assert.equal(history[1].tool_name, "search_library");
    assert.equal(history[2].content, answer);

    // What Ollama was sent: the system prompt from the file, the tools with their MCP descriptions, and the tool result.
    assert.equal(ollama.chats.length, 2);
    assert.equal(ollama.chats[0].messages[0].role, "system");
    assert.equal(ollama.chats[0].messages[0].content, "You are the test assistant.");
    assert.deepEqual(ollama.chats[0].tools.map((tool) => tool.function.name), ["search_library", "read_document"]);
    assert.deepEqual(ollama.chats[0].tools[0].function.parameters.properties.source.enum, ["library", "wiki", "wikipedia", "wikivoyage", "maps"]);
    assert.equal(ollama.chats[0].options.num_ctx, 16_384);
    assert.equal(ollama.chats[0].options.num_predict, 8192);
    assert.equal("think" in ollama.chats[0], false, "thinking is left to the model unless chat.think is set");
    assert.equal(ollama.chats[1].messages.at(-1).role, "tool");
    assert.match(ollama.chats[1].messages.at(-1).content, /first-aid/);

    // The next turn carries the history the page kept.
    const second = await chatTurn(other.url, { messages: [...history.slice(0, 0), { role: "user", content: "How long should I cool a burn?" }, ...history, { role: "user", content: "And bleeding?" }] });
    assert.equal(second.status, 200);
    assert.equal(ollama.chats.at(-2).messages.length, 6, "system, user, assistant, tool, assistant, user");

    const noTools = await chatTurn(other.url, { messages: [{ role: "user", content: "hi" }], model: "no-tools" });
    assert.equal(noTools.status, 400);
    assert.match(noTools.events[0].error, /cannot call tools/);
    const wrongOrder = await chatTurn(other.url, { messages: [{ role: "assistant", content: "x" }] });
    assert.equal(wrongOrder.status, 400);
    assert.match(wrongOrder.events[0].error, /last message must be from the user/);
  } finally {
    await other.close();
  }
  const noOllama = await chatTurn(server.url, { messages: [{ role: "user", content: "hi" }], model: "chatty:latest" });
  assert.equal(noOllama.status, 400);
  assert.match(noOllama.events[0].error, /needs Ollama/);
  // Without chat.url and without Ollama for embeddings, no Ollama address is assumed (an Ollama on this machine must not matter).
  const models = (await api("chat/models")).body;
  assert.deepEqual(models.models, []);
  assert.match(models.error, /set chat\.url/);
  writeConfig();
});

test("a model that thinks for too long is cut off, and thinking can be switched off", async () => {
  const other = await startServer({}, { chat: { url: ollama.url(), model: "chatty:latest", think: false, numPredict: 1024, timeoutSeconds: 1 } });
  try {
    ollama.chats.length = 0;
    const quick = await chatTurn(other.url, { messages: [{ role: "user", content: "hi" }] });
    assert.equal(quick.status, 200);
    assert.equal(ollama.chats[0].think, false);
    assert.equal(ollama.chats[0].options.num_predict, 1024);
    const looping = await chatTurn(other.url, { messages: [{ role: "user", content: "think hard" }], model: "looping" });
    assert.equal(looping.status, 200);
    const note = looping.events.find((event) => event.type === "token");
    assert.match(note.text, /used up its room on thinking/);
    assert.match(looping.events.find((event) => event.type === "message").message.content, /set chat\.think to false/);
    const slow = await chatTurn(other.url, { messages: [{ role: "user", content: "think hard" }], model: "slow" });
    assert.equal(slow.status, 200, "the stream had started");
    const last = slow.events.at(-1);
    assert.equal(last.type, "error");
    assert.match(last.message, /did not finish within 1 seconds/);
    assert.equal(slow.events[0].type, "thinking");
  } finally {
    await other.close();
  }
  writeConfig();
}, { timeout: 30_000 });

test("environment checks give platform advice", async () => {
  const config = loadConfig(configPath);
  const arviro = createArviro(config, {});
  try {
    const unreachable = await checkEnvironment({ ...config, embedding: { provider: "ollama", url: "http://127.0.0.1:1", model: "m", dimensions: 1 } }, arviro.status(), { platform: "linux", nodeVersion: "v20.1.0" });
    assert.equal(unreachable.find((check) => check.id === "ollama").ok, false);
    assert.match(unreachable.find((check) => check.id === "ollama").advice.command, /install\.sh/);
    assert.equal(unreachable.find((check) => check.id === "node").ok, false);
  } finally {
    arviro.close();
  }
  assert.equal(adviceFor("pdftotext", "win32").url.includes("poppler-windows"), true);
  assert.equal(adviceFor("osmium", "darwin").command, "brew install osmium-tool");
  assert.equal(adviceFor("unknown"), null);
  assert.equal(hasModel(["qwen3-embedding:0.6b"], "qwen3-embedding:0.6b"), true);
  assert.equal(hasModel(["nomic:latest"], "nomic"), true);
  assert.equal(hasModel(["other"], "nomic"), false);
});

test("the configuration file helpers keep unknown settings and validate input", () => {
  const raw = { dataDir: "~/data", custom: { keep: true } };
  setDocumentSource(raw, { id: "docs", path: "~/Docs", description: "", private: false });
  assert.deepEqual(raw.sources.docs, { path: "~/Docs", description: "Documents in ~/Docs" });
  setDocumentSource(raw, { id: "docs", path: "~/Docs", description: "Mine", private: true });
  assert.equal(raw.sources.docs.private, true);
  assert.throws(() => setDocumentSource(raw, { id: "maps", path: "x" }), /reserved/);
  addZimDownload(raw, "wikivoyage_nl_all_maxi", { defaultZimDir: "~/zim" });
  addZimDownload(raw, "wikivoyage_nl_all_maxi", { defaultZimDir: "~/other" });
  assert.deepEqual(raw.library.downloads, [{ zim: "wikivoyage_nl_all_maxi" }]);
  assert.equal(raw.kiwix.zimDir, "~/zim");
  addMapDownload(raw, { id: "be", url: "https://example.org/europe/belgium-latest.osm.pbf" }, { defaultMapsDir: "~/maps" });
  assert.equal(raw.maps.regions.be, "~/maps/belgium-latest.osm.pbf");
  addMapDownload(raw, { id: "be", url: "https://mirror.example/belgium-latest.osm.pbf" }, { defaultMapsDir: "~/maps" });
  assert.equal(raw.library.downloads.length, 2);
  assert.equal(raw.library.downloads[1].url, "https://mirror.example/belgium-latest.osm.pbf");
  removeDownload(raw, "be", { regionFileExists: () => true });
  assert.equal(raw.maps.regions.be, "~/maps/belgium-latest.osm.pbf", "a region with a file stays");
  assert.throws(() => removeDownload(raw, "be"), /not in the download list/);
  assert.equal(raw.custom.keep, true);
  assert.equal(homeRelative("/home/someone/Docs", "/home/someone"), "~/Docs");
  assert.equal(homeRelative("/srv/docs", "/home/someone"), "/srv/docs");

  const file = path.join(fixture.root, "written.json");
  const config = writeRawConfig(file, raw);
  assert.equal(config.sources.docs.private, true);
  assert.deepEqual(readRawConfig(file).custom, { keep: true });
  assert.deepEqual(readRawConfig(path.join(fixture.root, "absent.json")), {});
  fs.writeFileSync(file, "{broken");
  assert.throws(() => readRawConfig(file), /not valid JSON/);
  assert.throws(() => writeRawConfig(file, { sources: { "Bad Id": { path: "x" } } }), /Invalid source id/);
});

test("the server starts without a configuration file", () => {
  const config = loadConfig(path.join(fixture.root, "absent", "config.json"), { allowMissing: true });
  assert.equal(config.missing, true);
  assert.deepEqual(config.sources, {});
  assert.throws(() => loadConfig(path.join(fixture.root, "absent", "config.json")), /No configuration file/);
});
