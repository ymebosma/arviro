// Environment checks for the doctor command and the admin page: what is installed, what is missing,
// and what to do about it on this platform.
import fs from "node:fs";
import os from "node:os";

const OLLAMA_URL = "https://ollama.com/download";
const KIWIX_URL = "https://download.kiwix.org/release/kiwix-tools/";
const POPPLER_WINDOWS_URL = "https://github.com/oschwartz10612/poppler-windows/releases";

/** The helper programs, with what each one is for; `arviro setup` reports on all of them. */
export const HELPER_TOOLS = [
  { id: "pdftotext", configKey: "pdftotext", purpose: "reads PDF files" },
  { id: "kiwix-serve", configKey: "kiwixServe", purpose: "reads ZIM files" },
  { id: "osmium", configKey: "osmium", purpose: "indexes map data" },
];

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
      return { text: "Let Arviro download kiwix-tools, or download it yourself and put kiwix-serve in your PATH (or set tools.kiwixServe).", command: "arviro setup", url: KIWIX_URL };
    case "osmium":
      if (mac) return { text: "Install osmium-tool.", command: "brew install osmium-tool" };
      if (windows) return { text: "osmium-tool is available through conda-forge; without it, map data is not indexed.", command: "conda install -c conda-forge osmium-tool" };
      return { text: "Install osmium-tool.", command: "sudo apt install osmium-tool" };
    default:
      return null;
  }
}

/** Pull a model through Ollama's streaming /api/pull. */
export async function pullModel({ url, model }, line, fetchImpl = fetch) {
  const response = await fetchImpl(`${url}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
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
  return { model };
}

/** Embedding models are not chat models; Ollama lists both. */
export const isEmbeddingModel = (name) => /embed|bge|minilm|e5-|nomic/i.test(String(name));

const GB = 1024 ** 3;
/**
 * A chat model that calls tools well enough for the library, by the memory of this computer. The models are ones that
 * Survival LLM measured with library tools through Ollama (October 2026); `arviro eval` measures them on your own
 * library and language.
 */
export function recommendChatModel(memoryBytes = os.totalmem()) {
  const gigabytes = Math.round(memoryBytes / GB);
  if (memoryBytes >= 32 * GB) return { model: "qwen3.6", gigabytes, reason: "32 GB or more: Qwen 3.6, good with tools and in many languages" };
  if (memoryBytes >= 16 * GB) return { model: "granite4.2", gigabytes, reason: "16 to 31 GB: Granite 4.2 (8B), which searches and reads reliably" };
  return { model: "granite4.2:3b", gigabytes, reason: "less than 16 GB: Granite 4.2 3B, small but it does use the tools" };
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
export async function checkEnvironment(config, status, { fetchImpl = fetch, platform = process.platform, nodeVersion = process.version, memoryBytes = os.totalmem() } = {}) {
  const checks = [];
  const check = (id, label, ok, detail, extra = {}) => checks.push({ id, label, ok, detail, ...extra });

  const major = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
  check("node", "Node.js", major >= 22, nodeVersion, major >= 22 ? {} : { advice: { text: "Node.js 22.13 or newer is needed.", url: "https://nodejs.org" } });
  check("config", "configuration", !config.missing, config.missing ? `${config.configPath} does not exist yet; it is created when you add a source here` : config.configPath);

  const sources = Object.values(config.sources);
  check("sources", "sources", sources.length > 0, sources.length ? sources.map((source) => source.id).join(", ") : "none configured yet", sources.length ? {} : { advice: { text: "Add a document folder or download a ZIM file or map under Library." } });
  for (const source of sources) {
    if (source.type === "documents") check(`source:${source.id}`, `source ${source.id}`, fs.existsSync(source.root), source.root, fs.existsSync(source.root) ? {} : { advice: { text: "The folder does not exist. Connect the disk, or change or remove the source." } });
    if (source.type === "kiwix") {
      const reason = source.books.find((book) => book.idReason)?.idReason;
      check(`source:${source.id}`, `source ${source.id}`, true, `${source.books.map((book) => `${book.name}.zim`).join(", ")}${reason ? `; named "${source.id}" because ${reason}: use that id in kiwix.descriptions and kiwix.private` : ""}`);
    }
    if (source.type === "maps") {
      for (const [region, file] of Object.entries(source.regions)) check(`map:${region}`, `map region ${region}`, fs.existsSync(file), file, fs.existsSync(file) ? {} : { advice: { text: "The extract has not been downloaded yet: run the library update." }, fix: "library-update" });
    }
  }

  if (config.kiwix.staleKeys?.length) {
    const ids = sources.filter((source) => source.type === "kiwix").map((source) => source.id);
    check("kiwix-keys", "kiwix settings", false, `kiwix.descriptions or kiwix.private name ${config.kiwix.staleKeys.join(", ")}, which is not a ZIM source${ids.length ? ` (the sources are ${ids.join(", ")})` : ""}`, { advice: { text: "Rename or remove those keys in the configuration file; a source id changes when another book with the same first name part arrives." } });
  }
  if (sources.some((source) => source.type === "documents")) check("pdftotext", "pdftotext (reads PDF files)", Boolean(config.tools.pdftotext), config.tools.pdftotext || "not found", config.tools.pdftotext ? {} : { advice: adviceFor("pdftotext", platform) });
  if (config.kiwix.books.length || config.library.downloads.some((item) => item.kind === "zim")) check("kiwix-serve", "kiwix-serve (reads ZIM files)", Boolean(config.tools.kiwixServe), config.tools.kiwixServe || "not found", config.tools.kiwixServe ? {} : { advice: adviceFor("kiwix-serve", platform), fix: "kiwix-tools" });
  if (config.sources.maps) check("osmium", "osmium (indexes map data)", Boolean(config.tools.osmium), config.tools.osmium || "not found", config.tools.osmium ? {} : { advice: adviceFor("osmium", platform) });

  let ollamaNames;
  if (config.embedding.provider === "ollama") {
    ollamaNames = await ollamaModels(config.embedding.url, fetchImpl);
    const names = ollamaNames;
    if (names === null) check("ollama", "Ollama", false, `not reachable at ${config.embedding.url}`, { advice: adviceFor("ollama", platform) });
    else {
      check("ollama", "Ollama", true, config.embedding.url);
      const present = hasModel(names, config.embedding.model);
      check("embedding-model", "embedding model", present, present ? config.embedding.model : `${config.embedding.model} is not installed`, present ? {} : { advice: { text: "Pull the model.", command: `ollama pull ${config.embedding.model}` }, fix: "ollama-pull" });
    }
  } else {
    check("embeddings", "embeddings", true, "disabled; only literal matches are found");
  }

  // The Chat tab needs a chat model in the Ollama of the chat.
  const chatUrl = config.chat.url || (config.embedding.provider === "ollama" ? config.embedding.url : null);
  if (chatUrl) {
    const names = chatUrl === config.embedding.url && ollamaNames !== undefined ? ollamaNames : await ollamaModels(chatUrl, fetchImpl);
    if (names !== null) {
      const chatModels = names.filter((name) => !isEmbeddingModel(name));
      const suggestion = recommendChatModel(memoryBytes);
      const pull = (model) => ({ advice: { text: "Pull it.", command: `ollama pull ${model}` }, fix: "ollama-pull-chat" });
      if (config.chat.model) {
        const present = hasModel(names, config.chat.model);
        check("chat-model", "chat model", present, present ? config.chat.model : `${config.chat.model} (chat.model) is not installed`, present ? {} : pull(config.chat.model));
      } else if (chatModels.length) {
        check("chat-model", "chat model", true, `${chatModels.slice(0, 4).join(", ")}${chatModels.length > 4 ? ", …" : ""}${hasModel(chatModels, suggestion.model) ? "" : `; for this computer (${suggestion.gigabytes} GB) Arviro suggests ${suggestion.model}`}`);
      } else {
        check("chat-model", "chat model", false, `none yet; for this computer (${suggestion.gigabytes} GB): ${suggestion.reason}`, { advice: { text: "Pull a chat model that can call tools.", command: `ollama pull ${suggestion.model}` }, fix: "ollama-pull-chat" });
      }
    }
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
