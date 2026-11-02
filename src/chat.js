// The chat tab: a conversation with a model served by Ollama, with the library tools.
// The tools are the same MCP tools that any chat app gets (mcp.js), reached through an in-memory
// MCP client, so what the model sees here is exactly what it sees in Open WebUI. What the chat adds
// around the model is for small local models: a budget for thinking, a last round without tools, a
// second try when a turn ends without an answer, and a check of the sources an answer names.
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp.js";
import { isEmbeddingModel } from "./setup.js";
import { normalizeComparable, STOPWORDS, UserInputError } from "./text.js";

const DEFAULT_PROMPT_FILE = new URL("../examples/system-prompt.en.md", import.meta.url);
const MAX_MESSAGE_CHARS = 20_000;
const MAX_HISTORY = 60;
const TOOL_PREVIEW_CHARS = 1200;
const RESCUE_EXCERPTS = 4;
const RESCUE_EXCERPT_CHARS = 2500;
const TOOL_SEARCH = "search_library";
const TOOL_READ = "read_document";

// Notes from Arviro to the model. They go with one request only and never into the conversation the page keeps.
export const NOTES = Object.freeze({
  lastRound: "(Note from Arviro, not the user: you have used all library lookups for this question. Answer now from what you found, and name your sources. Do not call any more tools.)",
  thinkSearch: "(Note from Arviro, not the user: you have thought long enough. Search the library now if you need to, or answer.)",
  thinkAnswer: "(Note from Arviro, not the user: you have thought long enough. Answer now from what you found, briefly, and name your sources.)",
  rescue: "(Note from Arviro, not the user: you cannot look anything else up. Answer the question now from these library excerpts and name your sources.)",
});
// A tool call written out as text instead of made: some models do this when they get no tools.
const TOOL_MARKUP = ["<tool_call", "<function", "{\"name\": \"search_library", "{\"name\": \"read_document"];

/** Models Ollama has, without the embedding models; the first one is the default. */
export async function listChatModels(url, fetchImpl = fetch) {
  const response = await fetchImpl(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Ollama answered ${response.status}`);
  const models = ((await response.json()).models || []).map((model) => String(model.name));
  return models.filter((name) => !isEmbeddingModel(name));
}

/** Replace every `{{assistantName}}` in a prompt; the name is plain text, so nothing in it is interpreted. */
export function fillAssistantName(text, name) {
  return String(text).split("{{assistantName}}").join(name);
}

/** The conversation as the page sends it: only the roles and fields the model may see. */
function cleanHistory(messages) {
  if (!Array.isArray(messages)) throw new UserInputError("messages must be a list.");
  const kept = [];
  for (const message of messages.slice(-MAX_HISTORY)) {
    if (!message || typeof message !== "object") continue;
    const content = String(message.content ?? "").slice(0, MAX_MESSAGE_CHARS);
    if (message.role === "user" && content.trim()) kept.push({ role: "user", content });
    else if (message.role === "assistant") {
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.slice(0, 8) : null;
      kept.push({ role: "assistant", content, ...(toolCalls?.length ? { tool_calls: toolCalls } : {}) });
    } else if (message.role === "tool") kept.push({ role: "tool", content, ...(message.tool_name ? { tool_name: String(message.tool_name) } : {}) });
  }
  if (!kept.length || kept.at(-1).role !== "user") throw new UserInputError("The last message must be from the user.");
  return kept;
}

/** Parse Ollama's NDJSON stream into objects. */
async function* ndjson(body) {
  let buffered = "";
  for await (const chunk of body) {
    buffered += Buffer.from(chunk).toString("utf8");
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buffered.trim()) yield JSON.parse(buffered);
}

/** `text` without the characters of `set` at its start and its end; plain loops, so linear on any input. */
function strip(text, set, { start = true, end = true } = {}) {
  let from = 0;
  let to = text.length;
  if (start) while (from < to && set.includes(text[from])) from += 1;
  if (end) while (to > from && set.includes(text[to - 1])) to -= 1;
  return text.slice(from, to);
}

const normalPath = (value) => {
  let text = strip(strip(String(value || "").trim(), "/", { end: false }), ".:", { start: false });
  try { text = decodeURIComponent(text); } catch {}
  return text.toLowerCase();
};

/**
 * What the tools showed the model: documents it read and search results it saw, each { source, path, title }.
 * Built from the tool calls and results of a conversation, so earlier turns count too.
 */
export function createLedger() {
  const read = new Map();
  const seen = new Map();
  const key = (item) => `${item.source}\u0000${normalPath(item.path)}`;
  const ledger = {
    read,
    seen,
    sources: new Set(),
    /** Record one tool call and its result text. */
    record(name, args = {}, text = "") {
      if (args.source) ledger.sources.add(String(args.source));
      const refused = String(text).startsWith(`${name} could not do this`) || String(text).startsWith(`${name} failed`);
      if (name === TOOL_READ && args.source && args.path && !refused) {
        const item = { source: String(args.source), path: String(args.path), title: seen.get(key(args))?.title || null };
        if (!read.has(key(item))) read.set(key(item), item);
      }
      if (name === TOOL_SEARCH) {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        for (const result of parsed?.results || []) {
          const where = result?.read;
          if (where?.source && where?.path) {
            const item = { source: String(where.source), path: String(where.path), title: result.title ? String(result.title) : null };
            if (!seen.has(key(item))) seen.set(key(item), item);
          } else if (result?.name) {
            // A map result has no document; its name is what an answer cites.
            const item = { source: String(parsed.source || args.source || "maps"), path: "", title: String(result.name) };
            seen.set(`${item.source}\u0000name:${item.title.toLowerCase()}`, item);
          }
        }
      }
    },
    /** Every known document: what was read first, then what was only seen. */
    all: () => [...read.values(), ...[...seen.values()].filter((item) => !read.has(key(item)))],
  };
  return ledger;
}

/** Fill a ledger from the tool calls and results already in a conversation. */
function ledgerFromHistory(history) {
  const ledger = createLedger();
  let pending = [];
  for (const message of history) {
    if (message.role === "assistant") pending = [...(message.tool_calls || [])];
    else if (message.role === "tool" && pending.length) {
      const call = pending.shift()?.function || {};
      ledger.record(call.name, call.arguments && typeof call.arguments === "object" ? call.arguments : {}, message.content);
    }
  }
  return ledger;
}

const SOURCES_LINE = /^[\s*_#>-]*(?:sources?|bronnen|bron|quellen|quelle)\b[\s*_]*:?/i;
const NONE_ITEM = /^(?:none|geen|keine|aucune?|-)\b/i;
const PIECE_SPLIT = /[\s`"'<>,;]+/;

/** A word of an answer without the punctuation around it; brackets stay when they belong to it ("Mercury_(planet)"). */
function trimPiece(raw) {
  let piece = strip(strip(raw, "([*_", { end: false }), ".:!?*_", { start: false });
  const balance = { ")": 0, "]": 0 };
  for (const character of piece) {
    if (character === "(") balance[")"] -= 1;
    else if (character === ")") balance[")"] += 1;
    else if (character === "[") balance["]"] -= 1;
    else if (character === "]") balance["]"] += 1;
  }
  let end = piece.length;
  for (;;) {
    while (end > 0 && ".:!?*_".includes(piece[end - 1])) end -= 1;
    const last = piece[end - 1];
    if ((last === ")" || last === "]") && balance[last] > 0) { balance[last] -= 1; end -= 1; }
    else break;
  }
  return piece.slice(0, end);
}

/** The words of a title or file name that say what it is: lowercase, without accents, punctuation and stopwords. */
function contentWords(text) {
  return new Set(normalizeComparable(text).split(" ").filter((word) => word && !STOPWORDS.has(word) && !["pagina", "paginas", "page", "pages", "s", "p", "pdf", "line", "lines", "regel", "regels"].includes(word)));
}

/**
 * Whether a sources item names a known document by its words: (nearly) all words of its title or file name are in
 * the item ("WHO Technical Note 05: Emergency treatment of drinking-water (pages 1-2)" for the file
 * who-technical-note-05-emergency-treatment-drinking-water.pdf), or the item is a shortened title of two words or more.
 */
function namesByWords(itemWords, knownNames, sourceWords) {
  if (!itemWords.size) return false;
  return knownNames.some((names) => {
    let shared = 0;
    for (const word of names) if (itemWords.has(word)) shared += 1;
    if (names.size && shared >= Math.max(1, Math.ceil(names.size * 0.8))) {
      // A title of one or two words fits inside many made-up ones ("Water" in "Water purification handbook"):
      // then the item may add nothing but source names and page numbers.
      if (names.size > 2) return true;
      return [...itemWords].every((word) => names.has(word) || sourceWords.has(word) || /^\d+$/.test(word));
    }
    // A shortened title: two or more of its words, and nothing else but source names and numbers.
    const meaningful = [...itemWords].filter((word) => !sourceWords.has(word) && !/^\d+$/.test(word));
    return meaningful.length >= 2 && meaningful.every((word) => names.has(word));
  });
}

/**
 * The references in an answer that no tool showed the model: paths that were never in a search result or read,
 * and items of a closing "Sources:" line that name no known document, title or source.
 * Everything here works on plain splits and string comparisons, so it stays linear in the length of the answer.
 */
export function checkCitations(answer, ledger) {
  const text = String(answer || "");
  const known = ledger.all();
  const paths = known.filter((item) => item.path).map((item) => normalPath(item.path));
  const titles = known.map((item) => String(item.title || "").toLowerCase()).filter((title) => title.length >= 3);
  // The words of each title and each file name, for an item that cites a document in its own words.
  const knownNames = known.flatMap((item) => [contentWords(item.title || ""), contentWords(String(item.path || "").split("/").at(-1).replace(/\.[a-z0-9]{1,5}$/i, ""))]).filter((names) => names.size);
  const sourceIds = new Set([...ledger.sources, ...known.map((item) => item.source)].map((id) => id.toLowerCase()));
  const sourceWords = new Set([...sourceIds].flatMap((id) => normalizeComparable(id).split(" ")));
  const knownPath = (piece) => {
    const wanted = normalPath(piece);
    return paths.some((candidate) => candidate === wanted || candidate.endsWith(`/${wanted}`) || wanted.endsWith(`/${candidate}`));
  };
  const unverified = [];
  const flag = (value) => { if (!unverified.includes(value)) unverified.push(value); };

  // Paths and links: a piece with a slash that looks like a document path or an encyclopedia link.
  for (const raw of text.split(PIECE_SPLIT)) {
    const piece = trimPiece(raw);
    if (!piece.includes("/") || /^[a-z][a-z0-9+.-]*:\/\//i.test(piece)) continue;
    const looksLikeDocument = /\.[a-z0-9]{1,5}$/i.test(piece) || piece.startsWith("/kiwix/") || piece.startsWith("kiwix/");
    if (!looksLikeDocument) continue;
    const withoutSource = [...sourceIds].some((id) => piece.toLowerCase().startsWith(`${id}/`)) ? piece.slice(piece.indexOf("/") + 1) : piece;
    if (!knownPath(piece) && !knownPath(withoutSource)) flag(piece);
  }

  // The closing sources line, item by item.
  const lines = text.split("\n");
  const index = lines.findLastIndex((line) => SOURCES_LINE.test(line));
  if (index >= 0) {
    const head = lines[index].replace(SOURCES_LINE, "");
    const items = head.split(/;| \| /).map((item) => item.trim());
    for (const line of lines.slice(index + 1)) {
      const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (bullet) items.push(bullet[1].trim());
      else if (line.trim()) break;
    }
    for (const item of items.map((value) => strip(strip(value, "*_ \t", { end: false }), "*_. \t", { start: false })).filter(Boolean)) {
      if (NONE_ITEM.test(item)) continue;
      const lower = item.toLowerCase();
      // Literally: the same title, a longer title inside the item, or the item inside a title. Short titles go by their words below.
      const named = titles.some((title) => lower === title || (lower.includes(title) && contentWords(title).size > 2) || (title.includes(lower) && contentWords(lower).size >= 2))
        || namesByWords(contentWords(item), knownNames, sourceWords)
        || item.split(PIECE_SPLIT).some((piece) => piece.includes("/") && knownPath(trimPiece(piece)))
        || [...sourceIds].some((id) => lower === id || lower.startsWith(`${id} `) || lower.startsWith(`${id}:`) || lower.startsWith(`${id}/`));
      // A path in the item was already judged above.
      if (!named && !item.split(PIECE_SPLIT).some((piece) => unverified.includes(trimPiece(piece)))) flag(item);
    }
  }
  return unverified;
}

/** Whether a final message holds no answer: nothing, or a tool call written out as text. */
export function isEmptyAnswer(content) {
  const text = String(content || "").trim();
  return !text || TOOL_MARKUP.some((marker) => text.startsWith(marker));
}

/**
 * @param {object} options
 * @param {() => object} options.getArviro
 * @param {object} options.guard   the repeat guard shared with the HTTP endpoints
 */
export function createChat({ getArviro, guard, version, log = () => {}, fetchImpl = fetch }) {
  /** The system prompt with the assistant's name filled in: Arviro is the software, the assistant has its own name. */
  function systemPrompt(config) {
    const file = config.chat.systemPrompt || DEFAULT_PROMPT_FILE;
    let text;
    try { text = fs.readFileSync(file, "utf8").trim(); }
    catch (error) { throw new Error(`The system prompt file cannot be read (${error.code || error.message}); check chat.systemPrompt.`); }
    return fillAssistantName(text, config.chat.assistantName);
  }

  /** An MCP client connected to a fresh in-memory server for this conversation turn. */
  async function connectTools(arviro, sessionKey) {
    const server = createMcpServer(arviro, { scope: "all", guard, version, log, sessionKey });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "arviro-chat", version });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const { tools } = await client.listTools();
    return {
      definitions: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      async call(name, args) {
        const result = await client.callTool({ name, arguments: args });
        return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      },
      close: () => Promise.all([client.close(), server.close()]).catch(() => {}),
    };
  }

  /**
   * Run one turn: the model answers, calls tools as often as it may (chat.maxRounds), and answers.
   * Yields events for the page: { type: "thinking", text }, { type: "token", text }, { type: "tool", name, args },
   * { type: "toolResult", name, text }, { type: "message", message } (an assistant or tool message to keep in the history),
   * { type: "note", text } (what Arviro did, for the reader), { type: "retry" } (what streamed so far is not the answer),
   * and last { type: "turn", read, seen, unverified, looked, rescued, thinkCut, rounds }.
   */
  async function* run({ messages, model, signal, sessionKey = "chat" }) {
    const arviro = getArviro();
    const { config } = arviro;
    if (config.embedding.provider !== "ollama" && !config.chat.url) throw new UserInputError("The chat needs Ollama; set embedding.url or chat.url.");
    const url = config.chat.url || config.embedding.url;
    const chosen = String(model || config.chat.model || "").trim();
    if (!chosen) throw new UserInputError("Choose a model first.");
    if (!arviro.sources("all").length) throw new UserInputError("There are no sources yet; add some under Library.");
    const history = [{ role: "system", content: systemPrompt(config) }, ...cleanHistory(messages)];
    const ledger = ledgerFromHistory(history);
    const facts = { looked: false, rescued: false, thinkCut: false, rounds: 0 };
    const tools = await connectTools(arviro, sessionKey);

    /** One request to Ollama, streamed. Returns { content, toolCalls, doneReason, cut } once the model is done. */
    async function* ask({ outgoing, offerTools, think, budget }) {
      // A model that thinks for too long blocks every other Ollama request, including the embeddings of a search.
      const timeout = AbortSignal.timeout(config.chat.timeoutSeconds * 1000);
      const stop = new AbortController();
      const combined = AbortSignal.any([timeout, stop.signal, ...(signal ? [signal] : [])]);
      let response;
      try {
        response = await fetchImpl(`${url}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: chosen,
            messages: outgoing,
            ...(offerTools ? { tools: tools.definitions } : {}),
            stream: true,
            ...(think === null ? {} : { think }),
            options: { num_ctx: config.chat.numCtx, num_predict: config.chat.numPredict },
          }),
          signal: combined,
        });
      } catch (error) {
        if (timeout.aborted && !signal?.aborted) throw new UserInputError(`The model did not answer within ${config.chat.timeoutSeconds} seconds. Try a smaller model or a shorter question, or raise chat.timeoutSeconds.`);
        throw error;
      }
      if (!response.ok) {
        const text = (await response.text()).slice(0, 400);
        const detail = (() => { try { return JSON.parse(text).error; } catch { return text; } })();
        if (/does not support tools/i.test(String(detail))) throw new UserInputError(`The model "${chosen}" cannot call tools. Choose a model that can, such as qwen3 or llama3.1.`);
        if (response.status === 404) throw new UserInputError(`Ollama does not have the model "${chosen}". Pull it first: ollama pull ${chosen}`);
        throw new Error(`Ollama answered ${response.status}: ${detail}`);
      }
      let content = "";
      let doneReason = null;
      let thought = 0;
      const toolCalls = [];
      try {
        for await (const chunk of ndjson(response.body)) {
          if (chunk.error) throw new Error(String(chunk.error));
          if (chunk.done) doneReason = chunk.done_reason || null;
          const message = chunk.message || {};
          // A thinking model streams its reasoning apart from the answer; the page shows it dimmed, so a long think does not look like a hang.
          if (message.thinking) {
            yield { type: "thinking", text: String(message.thinking) };
            // Ollama streams about a token per chunk. Thinking past the budget, before any answer or call, is cut off.
            thought += 1;
            if (budget > 0 && thought > budget && !content && !toolCalls.length) {
              stop.abort();
              return { content: "", toolCalls: [], doneReason: null, cut: true };
            }
          }
          if (message.content) { content += message.content; yield { type: "token", text: message.content }; }
          for (const call of message.tool_calls || []) if (call?.function?.name) toolCalls.push({ function: { name: String(call.function.name), arguments: call.function.arguments && typeof call.function.arguments === "object" ? call.function.arguments : {} } });
          if (chunk.done) break;
        }
      } catch (error) {
        if (stop.signal.aborted) return { content: "", toolCalls: [], doneReason: null, cut: true };
        if (timeout.aborted && !signal?.aborted) throw new UserInputError(`The model did not finish within ${config.chat.timeoutSeconds} seconds. Try a smaller model or a shorter question, or raise chat.timeoutSeconds.`);
        throw error;
      }
      return { content, toolCalls, doneReason, cut: false };
    }

    /** The turn ended without an answer after lookups: give the model the best of what it found, once, without tools. */
    async function* rescue() {
      const excerpts = [];
      for (const message of history.filter((item) => item.role === "tool").reverse()) {
        if (excerpts.length >= RESCUE_EXCERPTS) break;
        if (message.content.trim()) excerpts.push(message.content.slice(0, RESCUE_EXCERPT_CHARS));
      }
      if (!excerpts.length) return null;
      yield { type: "retry" };
      yield { type: "note", text: "The model gave no answer after its lookups; it was asked once more with what it found." };
      const outgoing = [...history, { role: "user", content: `${NOTES.rescue}\n\n${excerpts.reverse().join("\n\n---\n\n")}` }];
      return yield* ask({ outgoing, offerTools: false, think: false, budget: 0 });
    }

    try {
      let note = null;
      for (let round = 0; ; round += 1) {
        facts.rounds = round + 1;
        const last = round >= config.chat.maxRounds;
        const answerNow = note === NOTES.thinkAnswer;
        // The last round has no tools: a model that would go on looking things up has to answer.
        if (last && !note) note = NOTES.lastRound;
        const offerTools = !last && !answerNow;
        const outgoing = note ? [...history, { role: "user", content: note }] : history;
        const nudged = Boolean(note);
        note = null;
        const result = yield* ask({ outgoing, offerTools, think: nudged ? false : config.chat.think, budget: nudged ? 0 : config.chat.thinkBudget });
        if (result.cut) {
          facts.thinkCut = true;
          yield { type: "note", text: `Thinking was stopped after ${config.chat.thinkBudget} tokens (chat.thinkBudget); the model was asked to go on without it.` };
          note = facts.looked ? NOTES.thinkAnswer : NOTES.thinkSearch;
          continue;
        }
        // A lookup asked for in a round without tools is not run.
        const toolCalls = offerTools ? result.toolCalls : [];
        let { content, doneReason } = result;

        if (!toolCalls.length) {
          if (isEmptyAnswer(content) && facts.looked) {
            const second = yield* rescue();
            if (second) {
              facts.rescued = true;
              ({ content, doneReason } = second);
            }
          }
          // The model ran out of room (chat.numPredict): say so, instead of ending the turn with silence.
          if (doneReason === "length") {
            const ending = content.trim()
              ? "\n\n[The answer was cut off at chat.numPredict tokens.]"
              : "[The model used up its room on thinking and gave no answer. Try again, or set chat.think to false.]";
            content += ending;
            yield { type: "token", text: ending };
          } else if (isEmptyAnswer(content)) {
            const ending = "[The model gave no answer. Try again, or try another model.]";
            content = ending;
            yield { type: "retry" };
            yield { type: "token", text: ending };
          }
          const unverified = checkCitations(content, ledger);
          if (unverified.length) {
            const warning = `\n\n[Arviro did not find ${unverified.map((item) => `"${item}"`).join(", ")} among the documents searched or read in this conversation; check it before relying on it.]`;
            content += warning;
            yield { type: "token", text: warning };
          }
          const assistant = { role: "assistant", content };
          history.push(assistant);
          yield { type: "message", message: assistant };
          yield { type: "turn", read: [...ledger.read.values()], seen: ledger.all().filter((item) => !ledger.read.has(`${item.source}\u0000${normalPath(item.path)}`)), unverified, ...facts };
          return;
        }

        const assistant = { role: "assistant", content, tool_calls: toolCalls };
        history.push(assistant);
        yield { type: "message", message: assistant };
        facts.looked = true;
        for (const call of toolCalls) {
          const { name, arguments: args } = call.function;
          yield { type: "tool", name, args };
          let text;
          try { text = await tools.call(name, args); }
          catch (error) { text = `${name} failed: ${error.message}`; }
          ledger.record(name, args, text);
          const toolMessage = { role: "tool", content: text, tool_name: name };
          history.push(toolMessage);
          yield { type: "toolResult", name, text: text.length > TOOL_PREVIEW_CHARS ? `${text.slice(0, TOOL_PREVIEW_CHARS)}…` : text };
          yield { type: "message", message: toolMessage };
        }
      }
    } finally {
      await tools.close();
    }
  }

  return { run, models: () => listChatModels(getArviro().config.chat.url || getArviro().config.embedding.url, fetchImpl) };
}
