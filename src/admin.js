// The admin page: a small JSON API under /admin/api/ and the static page under /admin/.
// It is for the owner only: it checks the environment, edits the configuration file, and runs
// long jobs (index builds, library updates, model pulls) one at a time. Nothing here is MCP.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createArviro } from "./arviro.js";
import { createCatalogue } from "./catalogue.js";
import { createChat } from "./chat.js";
import { ConfigError, expandHome, loadConfig } from "./config.js";
import { addMapDownload, addZimDownload, homeRelative, readRawConfig, removeDocumentSource, removeDownload, setDocumentSource, writeRawConfig } from "./configfile.js";
import { createEmbedder } from "./embeddings.js";
import { buildIndex } from "./indexer.js";
import { createLibrary, formatBytes } from "./library.js";
import { checkEnvironment } from "./setup.js";
import { UserInputError } from "./text.js";

const UI_DIR = fileURLToPath(new URL("./ui/", import.meta.url));
const STATIC = { "": "index.html", "index.html": "index.html", "app.js": "app.js", "style.css": "style.css" };
const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const MAX_LOG_LINES = 400;
const MAX_FOLDERS = 500;

/** One job at a time; the page polls its state. */
function createJobs(log) {
  let current = null;
  let counter = 0;

  function start(name, run) {
    if (current?.status === "running") throw new UserInputError(`"${current.name}" is still running; wait for it to finish.`);
    const job = { id: counter += 1, name, status: "running", startedAt: new Date().toISOString(), finishedAt: null, lines: [], result: null, error: null };
    const line = (message) => {
      job.lines.push(`${new Date().toISOString().slice(11, 19)} ${message}`);
      if (job.lines.length > MAX_LOG_LINES) job.lines.splice(0, job.lines.length - MAX_LOG_LINES);
      log(`${name}: ${message}`);
    };
    current = job;
    Promise.resolve().then(() => run(line)).then(
      (result) => { job.result = result ?? null; job.status = "done"; },
      (error) => { job.error = error.message; job.status = "failed"; log(`${name} failed: ${error.stack || error.message}`); },
    ).finally(() => { job.finishedAt = new Date().toISOString(); });
    return job;
  }

  return { start, get current() { return current; } };
}

/** Pull a model through Ollama's streaming /api/pull. */
async function pullModel(embedding, line, fetchImpl) {
  const response = await fetchImpl(`${embedding.url}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: embedding.model, stream: true }),
  });
  if (!response.ok) throw new Error(`Ollama answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  let buffered = "";
  let lastStatus = "";
  let nextPercent = 0;
  for await (const chunk of response.body) {
    buffered += Buffer.from(chunk).toString("utf8");
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const text = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!text) continue;
      const event = JSON.parse(text);
      if (event.error) throw new Error(event.error);
      if (event.total && event.completed != null) {
        const percent = Math.floor(event.completed / event.total * 100);
        if (percent >= nextPercent) { line(`${event.status}: ${percent}%`); nextPercent = percent + 10; }
      } else if (event.status && event.status !== lastStatus) {
        line(event.status);
        lastStatus = event.status;
        nextPercent = 0;
      }
    }
  }
  return { model: embedding.model };
}

/** Subfolders of a folder, for choosing a document source. Hidden folders are left out. */
export function listFolders(requested) {
  const target = path.resolve(expandHome(requested || os.homedir()));
  let entries;
  try { entries = fs.readdirSync(target, { withFileTypes: true }); }
  catch (error) { throw new UserInputError(`Cannot open that folder (${error.code || error.message}).`); }
  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: path.join(target, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .slice(0, MAX_FOLDERS);
  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, home: os.homedir(), folders };
}

/**
 * @param {object} options
 * @param {() => object} options.getArviro   the running application
 * @param {(next: object) => void} options.replace   swap in a new application after the configuration changed
 */
export function createAdmin({ getArviro, replace, guard, version, log = () => {}, fetchImpl = fetch, platform = process.platform }) {
  const jobs = createJobs(log);
  const config = () => getArviro().config;
  const chat = createChat({ getArviro, guard, version, log, fetchImpl });
  // One catalogue per pair of catalogue URLs, so that its cache of Geofabrik's region list survives a reload.
  let catalogueCache = null;
  function catalogue() {
    const { kiwixCatalog, geofabrikIndex } = config().library;
    if (catalogueCache?.kiwixCatalog !== kiwixCatalog || catalogueCache?.geofabrikIndex !== geofabrikIndex) {
      catalogueCache = { kiwixCatalog, geofabrikIndex, instance: createCatalogue({ kiwixCatalog, geofabrikIndex, fetchImpl }) };
    }
    return catalogueCache.instance;
  }

  function reload() {
    const current = config();
    const next = createArviro(loadConfig(current.configPath, { allowMissing: true }), { log });
    replace(next);
    if (next.config.kiwix.books.length && next.config.tools.kiwixServe) next.kiwix.ensure().catch((error) => log(`kiwix: ${error.message}`));
    return next;
  }

  /** Change the configuration file through `mutate(raw)`, validate it, write it and reload. */
  function changeConfig(mutate) {
    const current = config();
    const raw = readRawConfig(current.configPath);
    mutate(raw, current);
    writeRawConfig(current.configPath, raw);
    reload();
  }

  const defaults = (current) => ({
    zimDir: current.kiwix.zimDir || path.join(current.dataDir, "zim"),
    mapsDir: path.join(current.dataDir, "maps"),
    home: os.homedir(),
  });

  async function overview() {
    const arviro = getArviro();
    const current = arviro.config;
    const status = arviro.status();
    const checks = await checkEnvironment(current, status, { fetchImpl, platform });
    const { server } = current;
    return {
      version,
      platform,
      config: {
        path: current.configPath,
        missing: current.missing,
        dataDir: current.dataDir,
        server: { host: server.host, port: server.port, hasToken: Boolean(server.authToken), hasPublicToken: Boolean(server.publicToken) },
        embedding: current.embedding,
      },
      checks,
      sources: status.sources,
      index: status.index,
      library: createLibrary(current, { log }).status(),
      downloads: current.library.downloads.map((item) => ({ id: item.id, kind: item.kind, ...(item.kind === "map" ? { url: item.url, file: item.file } : {}) })),
      defaults: defaults(current),
      job: jobs.current,
    };
  }

  function startJob({ job, names = [], force = false }) {
    const current = config();
    const nameList = Array.isArray(names) ? names.map(String).slice(0, 50) : [];
    if (job === "index") return jobs.start("index", (line) => buildIndex(current, createEmbedder(current.embedding), { log: line }));
    if (job === "library-check") {
      return jobs.start("library check", async (line) => {
        const rows = await createLibrary(current, { log: line }).check(nameList);
        for (const row of rows) {
          const remote = row.remote ? `${row.remote.file}${row.remote.bytes ? ` (${formatBytes(row.remote.bytes)})` : ""}` : "";
          line(`${row.id}: ${row.verdict === "newer" ? `newer edition ${remote}` : row.verdict === "missing" ? `available: ${remote}` : row.verdict === "error" ? `error: ${row.error}` : row.verdict}`);
        }
        return rows;
      });
    }
    if (job === "library-update") {
      return jobs.start("library update", async (line) => {
        const summary = await createLibrary(current, { log: line }).update(nameList, { force: Boolean(force) });
        for (const row of summary.items) line(`${row.id}: ${row.action}${row.file ? ` ${row.file}` : ""}${row.error ? ` (${row.error})` : ""}`);
        if (summary.downloaded && current.library.indexAfterUpdate) {
          line("updating the search index");
          summary.index = await buildIndex(current, createEmbedder(current.embedding), { log: line });
        }
        if (summary.downloaded) reload();
        return summary;
      });
    }
    if (job === "ollama-pull") {
      if (current.embedding.provider !== "ollama") throw new UserInputError("Embeddings are disabled in the configuration.");
      return jobs.start(`pull ${current.embedding.model}`, (line) => pullModel(current.embedding, line, fetchImpl));
    }
    throw new UserInputError(`Unknown job "${job}".`);
  }

  /** Handle one API call. Returns { status, body }. */
  async function api(method, route, query, body) {
    if (method === "GET" && route === "overview") return { status: 200, body: await overview() };
    if (method === "GET" && route === "jobs") return { status: 200, body: { job: jobs.current } };
    if (method === "GET" && route === "chat/models") {
      const current = config();
      try {
        const models = await chat.models();
        return { status: 200, body: { models, default: current.chat.model || models[0] || null, url: current.chat.url || current.embedding.url } };
      } catch (error) {
        return { status: 200, body: { models: [], default: current.chat.model || null, url: current.chat.url || current.embedding.url, error: "Ollama is not reachable; see Environment." } };
      }
    }
    if (method === "GET" && route === "folders") return { status: 200, body: listFolders(query.get("path")) };
    if (method === "GET" && route === "catalogue") {
      const kind = query.get("kind") === "map" ? "map" : "zim";
      const curated = catalogue().curated.filter((item) => item.kind === kind);
      const search = (query.get("query") || "").trim();
      const lang = (query.get("lang") || "").trim();
      // Without a search, only the curated choices are shown; the whole catalogue is too much to browse.
      if (!search && !lang) return { status: 200, body: { kind, curated, results: [] } };
      try {
        const results = kind === "zim" ? await catalogue().searchZim({ query: search, lang }) : await catalogue().searchMaps({ query: search });
        return { status: 200, body: { kind, curated, results } };
      } catch (error) {
        log(`catalogue: ${error.message}`);
        return { status: 200, body: { kind, curated, results: [], error: "The catalogue could not be reached. Is this computer online?" } };
      }
    }
    if (method !== "POST") throw new UserInputError("Unknown admin call.");
    const input = body && typeof body === "object" ? body : {};
    if (route === "jobs") return { status: 202, body: { job: startJob(input) } };
    if (route === "sources") {
      const folder = path.resolve(expandHome(String(input.path || "")));
      if (!input.path || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new UserInputError("That folder does not exist.");
      changeConfig((raw) => setDocumentSource(raw, { id: String(input.id || ""), path: homeRelative(folder), description: input.description, private: input.private === true }));
    } else if (route === "sources/remove") {
      changeConfig((raw) => removeDocumentSource(raw, String(input.id || "")));
    } else if (route === "downloads") {
      changeConfig((raw, current) => {
        const { zimDir, mapsDir } = defaults(current);
        if (input.zim) addZimDownload(raw, String(input.zim), { defaultZimDir: homeRelative(zimDir) });
        else if (input.map) addMapDownload(raw, { id: String(input.map), url: String(input.url || "") }, { defaultMapsDir: homeRelative(mapsDir) });
        else throw new UserInputError('Give "zim" (a book name) or "map" and "url".');
      });
    } else if (route === "downloads/remove") {
      changeConfig((raw, current) => removeDownload(raw, String(input.id || ""), { regionFileExists: (region) => fs.existsSync(current.sources.maps?.regions?.[region] || "") }));
    } else {
      throw new UserInputError("Unknown admin call.");
    }
    return { status: 200, body: await overview() };
  }

  /** A static file of the page, or null. */
  function staticFile(name) {
    const file = STATIC[name];
    if (!file) return null;
    return { body: fs.readFileSync(path.join(UI_DIR, file)), type: CONTENT_TYPES[path.extname(file)] };
  }

  /** A streaming call: the chat. Returns an async iterator of events. */
  function stream(route, body, signal) {
    if (route !== "chat") throw new UserInputError("Unknown admin call.");
    const input = body && typeof body === "object" ? body : {};
    // Each turn is its own guard session: the repeat guard then catches loops within a turn, as it does per chat connection.
    return chat.run({ messages: input.messages, model: input.model, signal, sessionKey: `chat:${Date.now()}:${Math.random()}` });
  }

  return { api, stream, staticFile, reload, jobs };
}

export { ConfigError };
