// Loads and validates the configuration file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "arviro", "config.json");
const SOURCE_ID = /^[a-z][a-z0-9_-]{0,30}$/;
const DEFAULT_EXCLUDES = [".git", "node_modules", "zim", "pmtiles", "vendor"];
const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin"), "/usr/bin", "/bin"];

// Dutch question words mapped to the English terms used in most reference documents.
const DEFAULT_QUERY_EXPANSIONS = [
  ["\\b(?:thuis|huis|huishouden)\\b", "home household"],
  ["\\b(?:medisch|medische|eerste\\s*hulp|eerstehulp)\\b", "medical first aid"],
  ["\\b(?:noodsituatie|noodsituaties|noodgeval|noodgevallen)\\b", "emergency"],
  ["\\b(?:middelen|uitrusting|benodigdheden|voorraad|voorraden)\\b", "supplies equipment kit contents"],
  ["\\b(?:verband|verbanden|wond|wonden|bloeding|bloedingen)\\b", "bandages dressings wound bleeding"],
  ["\\b(?:handschoen|handschoenen|oogbescherming|ontsmetting)\\b", "gloves eye protection antiseptic"],
  ["\\b(?:reanimatie|hartstilstand)\\b", "CPR resuscitation cardiac arrest"],
  ["\\b(?:brandwond|brandwonden)\\b", "burn burns"],
  ["\\b(?:drinkwater|water\\s+zuiveren)\\b", "drinking water water treatment"],
  ["\\b(?:stroomuitval|stroomstoring)\\b", "power outage"],
  ["\\b(?:onderdak|schuilplaats)\\b", "shelter"],
];

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

export function expandHome(value) {
  const text = String(value);
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function resolvePath(value, baseDir) {
  return path.resolve(baseDir, expandHome(value));
}

/** Find an executable by name on PATH and in the usual Homebrew and user directories. */
export function findExecutable(name, extraDirs = EXTRA_BIN_DIRS) {
  const directories = [...String(process.env.PATH || "").split(path.delimiter), ...extraDirs].filter(Boolean);
  for (const directory of new Set(directories)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function toolPath(configured, name, baseDir) {
  if (configured === false) return null;
  if (configured) return resolvePath(configured, baseDir);
  return findExecutable(name);
}

function asObject(value, label) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`${label} must be an object.`);
  return value;
}

function documentSource(id, raw, baseDir) {
  const entry = asObject(raw, `sources.${id}`);
  if (!entry.path) throw new ConfigError(`sources.${id}.path is required.`);
  const routes = (entry.routes || []).map((route, index) => {
    if (!route?.prefix || !Array.isArray(route.terms)) throw new ConfigError(`sources.${id}.routes[${index}] needs "prefix" and "terms".`);
    return { prefix: String(route.prefix).replace(/^\/+|\/+$/g, ""), terms: route.terms.map((term) => String(term).toLocaleLowerCase("nl")) };
  });
  return {
    id,
    type: "documents",
    root: resolvePath(entry.path, baseDir),
    description: String(entry.description || `Documents in ${entry.path}`),
    private: entry.private === true,
    expandQueries: entry.expandQueries === true,
    routes,
    exclude: new Set([...DEFAULT_EXCLUDES, ...(entry.exclude || []).map(String)]),
    nested: [], // folders of other sources that lie inside this one; filled in below
  };
}

function realPathOrSelf(target) {
  try { return fs.realpathSync(target); } catch { return target; }
}

/**
 * A source folder inside another source's folder is left out of the outer source.
 * Its documents are then found in one place only, and a private folder inside a public one stays private.
 */
function linkNestedSources(documentSources) {
  for (const outer of documentSources) {
    for (const inner of documentSources) {
      if (outer === inner) continue;
      const relative = path.relative(realPathOrSelf(outer.root), realPathOrSelf(inner.root));
      if (relative === "") throw new ConfigError(`Sources "${outer.id}" and "${inner.id}" use the same folder.`);
      const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
      if (!outside) outer.nested.push(inner.root);
    }
  }
}

/**
 * ZIM files in a directory, newest edition per series.
 * "wikipedia_nl_all_nopic_2026-04.zim" belongs to series "wikipedia_nl_all_nopic" and source "wikipedia".
 */
export function discoverBooks(zimDir) {
  let names;
  try { names = fs.readdirSync(zimDir).filter((name) => name.endsWith(".zim")).sort(); } catch { return []; }
  const newest = new Map();
  for (const fileName of names) {
    const name = fileName.slice(0, -4);
    const series = name.replace(/_\d{4}-\d{2}(?:-\d{2})?$/, "");
    newest.set(series, { name, series, file: path.join(zimDir, fileName), sourceId: series.split("_")[0].toLowerCase() });
  }
  return [...newest.values()];
}

/** Turn the parsed JSON of a config file into the normalized configuration object. */
export function normalizeConfig(raw, { configPath = null } = {}) {
  const input = asObject(raw, "The configuration");
  const baseDir = configPath ? path.dirname(configPath) : process.cwd();
  const dataDir = resolvePath(input.dataDir || "~/.local/share/arviro", baseDir);

  const sources = {};
  for (const [id, entry] of Object.entries(asObject(input.sources, "sources"))) {
    if (!SOURCE_ID.test(id)) throw new ConfigError(`Invalid source id "${id}": use lowercase letters, digits, "-" or "_".`);
    if (id === "maps") throw new ConfigError('The source id "maps" is reserved; configure map data under "maps".');
    sources[id] = documentSource(id, entry, baseDir);
  }
  linkNestedSources(Object.values(sources));

  const kiwixInput = asObject(input.kiwix, "kiwix");
  const books = kiwixInput.zimDir ? discoverBooks(resolvePath(kiwixInput.zimDir, baseDir)) : [];
  const kiwixDescriptions = asObject(kiwixInput.descriptions, "kiwix.descriptions");
  const privateBooks = new Set((kiwixInput.private || []).map(String));
  for (const book of books) {
    if (!SOURCE_ID.test(book.sourceId)) throw new ConfigError(`Cannot derive a source id from ZIM file "${book.name}.zim".`);
    const existing = sources[book.sourceId];
    if (existing && existing.type !== "kiwix") throw new ConfigError(`Source id "${book.sourceId}" is used by both a document source and a ZIM file.`);
    if (existing) { existing.books.push(book); continue; }
    sources[book.sourceId] = {
      id: book.sourceId,
      type: "kiwix",
      description: String(kiwixDescriptions[book.sourceId] || `Offline ${book.sourceId} (Kiwix)`),
      private: privateBooks.has(book.sourceId),
      books: [book],
    };
  }

  const mapsInput = asObject(input.maps, "maps");
  const regions = {};
  for (const [region, file] of Object.entries(asObject(mapsInput.regions, "maps.regions"))) {
    if (!SOURCE_ID.test(region)) throw new ConfigError(`Invalid map region id "${region}".`);
    regions[region] = resolvePath(file, baseDir);
  }
  if (Object.keys(regions).length) {
    sources.maps = {
      id: "maps",
      type: "maps",
      description: String(mapsInput.description || `OpenStreetMap places and amenities (${Object.keys(regions).join(", ")}), with distances`),
      private: mapsInput.private === true,
      regions,
    };
  }

  const embeddingInput = asObject(input.embedding, "embedding");
  const provider = embeddingInput.provider || "ollama";
  if (!["ollama", "none"].includes(provider)) throw new ConfigError('embedding.provider must be "ollama" or "none".');
  const embedding = {
    provider,
    url: String(embeddingInput.url || "http://127.0.0.1:11434").replace(/\/+$/, ""),
    model: provider === "none" ? "none" : String(embeddingInput.model || "qwen3-embedding:0.6b"),
    dimensions: Number(embeddingInput.dimensions || 512),
  };
  if (!Number.isInteger(embedding.dimensions) || embedding.dimensions < 1) throw new ConfigError("embedding.dimensions must be a positive whole number.");

  const serverInput = asObject(input.server, "server");
  const server = {
    host: String(serverInput.host || "127.0.0.1"),
    port: Number(serverInput.port ?? 8765),
    // authToken protects /mcp (all sources); publicToken protects /public/mcp.
    authToken: serverInput.authToken ? String(serverInput.authToken) : null,
    publicToken: serverInput.publicToken ? String(serverInput.publicToken) : null,
    allowedHosts: (serverInput.allowedHosts || []).map(String),
    allowedOrigins: (serverInput.allowedOrigins || []).map(String),
  };
  if (!Number.isInteger(server.port) || server.port < 0 || server.port > 65535) throw new ConfigError("server.port must be a port number.");

  const toolsInput = asObject(input.tools, "tools");
  const tools = {
    pdftotext: toolPath(toolsInput.pdftotext, "pdftotext", baseDir),
    kiwixServe: toolPath(toolsInput.kiwixServe, "kiwix-serve", baseDir),
    osmium: toolPath(toolsInput.osmium, "osmium", baseDir),
  };

  const searchInput = asObject(input.search, "search");
  const expansions = (searchInput.queryExpansions || DEFAULT_QUERY_EXPANSIONS).map((item, index) => {
    const [pattern, add] = Array.isArray(item) ? item : [item?.pattern, item?.add];
    if (!pattern || !add) throw new ConfigError(`search.queryExpansions[${index}] needs a pattern and the terms to add.`);
    try { return { pattern: new RegExp(pattern, "u"), add: String(add) }; }
    catch (error) { throw new ConfigError(`search.queryExpansions[${index}] is not a valid regular expression: ${error.message}`); }
  });

  const guardInput = asObject(input.guard, "guard");
  return {
    configPath,
    dataDir,
    indexPath: path.join(dataDir, "index.sqlite"),
    sources,
    kiwix: {
      host: "127.0.0.1",
      port: Number(kiwixInput.port ?? 8767),
      urlRoot: "/kiwix",
      books,
    },
    embedding,
    server,
    tools,
    search: {
      minSemanticScore: Number(searchInput.minSemanticScore ?? 0.76),
      queryExpansions: expansions,
    },
    read: {
      maxChars: Number(asObject(input.read, "read").maxChars ?? 12_000),
    },
    guard: {
      windowMs: Number(guardInput.windowMs ?? 60_000),
      maxCallsPerWindow: Number(guardInput.maxCallsPerWindow ?? 20),
      maxCallsTotal: Number(guardInput.maxCallsTotal ?? 120),
    },
  };
}

/** Read the config file given explicitly, by $ARVIRO_CONFIG, or at the default location. */
export function loadConfig(explicitPath = null) {
  const configPath = path.resolve(expandHome(explicitPath || process.env.ARVIRO_CONFIG || DEFAULT_CONFIG_PATH));
  let text;
  try { text = fs.readFileSync(configPath, "utf8"); }
  catch { throw new ConfigError(`No configuration file at ${configPath}. Copy arviro.config.example.json there and edit it, or pass --config <file>.`); }
  let raw;
  try { raw = JSON.parse(text); }
  catch (error) { throw new ConfigError(`${configPath} is not valid JSON: ${error.message}`); }
  return normalizeConfig(raw, { configPath });
}

/** Sources visible in a scope: "all" (default) or "public" (no private sources). */
export function sourcesInScope(config, scope = "all") {
  return Object.values(config.sources).filter((source) => scope !== "public" || !source.private);
}
