// Reading and changing the owner's configuration file from the admin page.
// The file is edited as plain JSON, so settings the admin page does not know about are kept as they are.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, normalizeConfig } from "./config.js";

const SOURCE_ID = /^[a-z][a-z0-9_-]{0,30}$/;
const ZIM_NAME = /^[a-z0-9][a-z0-9._-]{0,120}$/i;

/** The raw JSON of the configuration file, or an empty object when the file does not exist yet. */
export function readRawConfig(configPath) {
  let text;
  try { text = fs.readFileSync(configPath, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw new ConfigError(`Cannot read ${configPath}: ${error.message}`);
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`${configPath} must contain a JSON object.`);
    return raw;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${configPath} is not valid JSON: ${error.message}`);
  }
}

/** The indentation a JSON file uses (two spaces when it cannot be told). */
function indentationOf(configPath) {
  try { return fs.readFileSync(configPath, "utf8").match(/^(\t+| {2,8})"/m)?.[1] || "  "; }
  catch { return "  "; }
}

/** Write the configuration atomically, after checking that it is valid. Returns the normalized configuration. */
export function writeRawConfig(configPath, raw) {
  const config = normalizeConfig(raw, { configPath });
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(raw, null, indentationOf(configPath))}\n`, { mode: 0o600 });
  fs.renameSync(temporary, configPath);
  return config;
}

/** Shorten a path under the home folder to "~/...", as the examples write it. */
export function homeRelative(file, home = os.homedir()) {
  if (home && (file === home || file.startsWith(`${home}${path.sep}`))) return `~${file.slice(home.length).split(path.sep).join("/")}`;
  return file;
}

function asObject(raw, key) {
  if (raw[key] == null) raw[key] = {};
  if (typeof raw[key] !== "object" || Array.isArray(raw[key])) throw new ConfigError(`${key} must be an object.`);
  return raw[key];
}

/** Add or replace a document source. */
export function setDocumentSource(raw, { id, path: folder, description, private: isPrivate }) {
  if (!SOURCE_ID.test(String(id || ""))) throw new ConfigError('The source id must be lowercase letters, digits, "-" or "_", starting with a letter.');
  if (id === "maps") throw new ConfigError('The id "maps" is reserved for map data.');
  if (!folder || typeof folder !== "string") throw new ConfigError("A folder is required.");
  const sources = asObject(raw, "sources");
  const existing = sources[id] && typeof sources[id] === "object" ? sources[id] : {};
  sources[id] = {
    ...existing,
    path: folder,
    description: String(description || existing.description || "").trim() || `Documents in ${folder}`,
    ...(isPrivate ? { private: true } : {}),
  };
  if (!isPrivate) delete sources[id].private;
  return raw;
}

export function removeDocumentSource(raw, id) {
  const sources = asObject(raw, "sources");
  if (!sources[id]) throw new ConfigError(`There is no source "${id}".`);
  delete sources[id];
  return raw;
}

function downloads(raw) {
  const library = asObject(raw, "library");
  if (library.downloads == null) library.downloads = [];
  if (!Array.isArray(library.downloads)) throw new ConfigError("library.downloads must be a list.");
  return library.downloads;
}

/** Add a ZIM book to the download list; `kiwix.zimDir` gets a default when it is not set. */
export function addZimDownload(raw, name, { defaultZimDir }) {
  if (!ZIM_NAME.test(String(name || ""))) throw new ConfigError("That is not a ZIM name.");
  const kiwix = asObject(raw, "kiwix");
  if (!kiwix.zimDir) kiwix.zimDir = defaultZimDir;
  const list = downloads(raw);
  if (!list.some((item) => item && item.zim === name)) list.push({ zim: name });
  return raw;
}

/** Add a map extract to the download list and to `maps.regions`. */
export function addMapDownload(raw, { id, url }, { defaultMapsDir }) {
  if (!SOURCE_ID.test(String(id || ""))) throw new ConfigError('The region id must be lowercase letters, digits, "-" or "_".');
  let parsed;
  try { parsed = new URL(String(url)); } catch { throw new ConfigError("The extract needs a valid URL."); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new ConfigError("The extract URL must be http or https.");
  const fileName = decodeURIComponent(parsed.pathname.split("/").at(-1) || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(osm\.pbf|pbf)$/.test(fileName)) throw new ConfigError("The URL must point at an .osm.pbf file.");
  const maps = asObject(raw, "maps");
  const regions = asObject(maps, "regions");
  if (!regions[id]) regions[id] = `${defaultMapsDir.replace(/\/+$/, "")}/${fileName}`;
  const list = downloads(raw);
  const existing = list.find((item) => item && item.map === id);
  if (existing) existing.url = parsed.href;
  else list.push({ map: id, url: parsed.href });
  return raw;
}

/** Remove a download from the list. A map region stays in `maps.regions` as long as its file exists. */
export function removeDownload(raw, id, { regionFileExists = () => false } = {}) {
  const list = downloads(raw);
  const index = list.findIndex((item) => item && (item.zim === id || item.map === id));
  if (index < 0) throw new ConfigError(`"${id}" is not in the download list.`);
  const [removed] = list.splice(index, 1);
  if (removed.map && raw.maps?.regions?.[removed.map] && !regionFileExists(removed.map)) delete raw.maps.regions[removed.map];
  return raw;
}
