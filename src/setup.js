// Environment checks for the doctor command and the admin page: what is installed, what is missing,
// and what to do about it on this platform.
import fs from "node:fs";

const OLLAMA_URL = "https://ollama.com/download";
const KIWIX_URL = "https://download.kiwix.org/release/kiwix-tools/";
const POPPLER_WINDOWS_URL = "https://github.com/oschwartz10612/poppler-windows/releases";

/** Installation advice per helper program and platform: { text, command?, url? }. */
export function adviceFor(tool, platform = process.platform) {
  const mac = platform === "darwin";
  const windows = platform === "win32";
  switch (tool) {
    case "ollama":
      if (mac) return { text: "Install Ollama and start it.", command: "brew install ollama && brew services start ollama", url: OLLAMA_URL };
      if (windows) return { text: "Install Ollama from ollama.com and start it.", url: OLLAMA_URL };
      return { text: "Install Ollama and start it.", command: "curl -fsSL https://ollama.com/install.sh | sh", url: OLLAMA_URL };
    case "pdftotext":
      if (mac) return { text: "Install poppler, which provides pdftotext.", command: "brew install poppler" };
      if (windows) return { text: "Install Poppler for Windows and add its bin folder to PATH, or set tools.pdftotext.", url: POPPLER_WINDOWS_URL };
      return { text: "Install poppler-utils, which provides pdftotext.", command: "sudo apt install poppler-utils" };
    case "kiwix-serve":
      return { text: "Download kiwix-tools and put kiwix-serve in your PATH (or in ~/.local/bin), or set tools.kiwixServe.", url: KIWIX_URL };
    case "osmium":
      if (mac) return { text: "Install osmium-tool.", command: "brew install osmium-tool" };
      if (windows) return { text: "osmium-tool is available through conda-forge; without it, map data is not indexed.", command: "conda install -c conda-forge osmium-tool" };
      return { text: "Install osmium-tool.", command: "sudo apt install osmium-tool" };
    default:
      return null;
  }
}

/** Names of the models Ollama has, or null when it is not reachable. */
export async function ollamaModels(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    return ((await response.json()).models || []).map((model) => String(model.name));
  } catch {
    return null;
  }
}

export function hasModel(names, model) {
  return names.some((name) => name === model || name === `${model}:latest` || `${name}:latest` === model);
}

/**
 * Every check is { id, label, ok, detail, advice?, fix? }. `fix` names an action the admin page can
 * run by itself ("ollama-pull", "index"); `advice` is what to do by hand.
 * @param {object} config  normalized configuration
 * @param {object} status  the result of arviro.status()
 */
export async function checkEnvironment(config, status, { fetchImpl = fetch, platform = process.platform, nodeVersion = process.version } = {}) {
  const checks = [];
  const check = (id, label, ok, detail, extra = {}) => checks.push({ id, label, ok, detail, ...extra });

  const major = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
  check("node", "Node.js", major >= 22, nodeVersion, major >= 22 ? {} : { advice: { text: "Node.js 22.13 or newer is needed.", url: "https://nodejs.org" } });
  check("config", "configuration", !config.missing, config.missing ? `${config.configPath} does not exist yet; it is created when you add a source here` : config.configPath);

  const sources = Object.values(config.sources);
  check("sources", "sources", sources.length > 0, sources.length ? sources.map((source) => source.id).join(", ") : "none configured yet", sources.length ? {} : { advice: { text: "Add a document folder or download a ZIM file or map under Library." } });
  for (const source of sources) {
    if (source.type === "documents") check(`source:${source.id}`, `source ${source.id}`, fs.existsSync(source.root), source.root, fs.existsSync(source.root) ? {} : { advice: { text: "The folder does not exist. Connect the disk, or change or remove the source." } });
    if (source.type === "kiwix") check(`source:${source.id}`, `source ${source.id}`, true, source.books.map((book) => `${book.name}.zim`).join(", "));
    if (source.type === "maps") {
      for (const [region, file] of Object.entries(source.regions)) check(`map:${region}`, `map region ${region}`, fs.existsSync(file), file, fs.existsSync(file) ? {} : { advice: { text: "The extract has not been downloaded yet: run the library update." }, fix: "library-update" });
    }
  }

  if (sources.some((source) => source.type === "documents")) check("pdftotext", "pdftotext (reads PDF files)", Boolean(config.tools.pdftotext), config.tools.pdftotext || "not found", config.tools.pdftotext ? {} : { advice: adviceFor("pdftotext", platform) });
  if (config.kiwix.books.length || config.library.downloads.some((item) => item.kind === "zim")) check("kiwix-serve", "kiwix-serve (reads ZIM files)", Boolean(config.tools.kiwixServe), config.tools.kiwixServe || "not found", config.tools.kiwixServe ? {} : { advice: adviceFor("kiwix-serve", platform) });
  if (config.sources.maps) check("osmium", "osmium (indexes map data)", Boolean(config.tools.osmium), config.tools.osmium || "not found", config.tools.osmium ? {} : { advice: adviceFor("osmium", platform) });

  if (config.embedding.provider === "ollama") {
    const names = await ollamaModels(config.embedding.url, fetchImpl);
    if (names === null) check("ollama", "Ollama", false, `not reachable at ${config.embedding.url}`, { advice: adviceFor("ollama", platform) });
    else {
      check("ollama", "Ollama", true, config.embedding.url);
      const present = hasModel(names, config.embedding.model);
      check("embedding-model", "embedding model", present, present ? config.embedding.model : `${config.embedding.model} is not installed`, present ? {} : { advice: { text: "Pull the model.", command: `ollama pull ${config.embedding.model}` }, fix: "ollama-pull" });
    }
  } else {
    check("embeddings", "embeddings", true, "disabled; only literal matches are found");
  }

  const { index } = status;
  if (!index.exists) check("index", "search index", false, "not built yet", { advice: { text: "Build the search index.", command: "arviro index" }, fix: "index" });
  else {
    const dimensions = config.embedding.provider === "none" ? 0 : config.embedding.dimensions;
    const settingsMatch = index.model === config.embedding.model && (index.dimensions === null || index.dimensions === dimensions);
    const ok = index.buildStatus === "ready" && settingsMatch;
    check("index", "search index", ok,
      `${index.documents.map((row) => `${row.source} ${row.documents} documents`).join(", ") || "empty"}; updated ${index.updatedAt || "never"}`
      + (settingsMatch ? "" : `; built with other embedding settings (${index.model})`)
      + (index.buildStatus === "ready" ? "" : "; last build did not finish"),
      ok ? {} : { advice: { text: "Run the index again.", command: "arviro index" }, fix: "index" });
  }
  return checks;
}
