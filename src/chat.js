// The chat tab: a conversation with a model served by Ollama, with the library tools.
// The tools are the same MCP tools that any chat app gets (mcp.js), reached through an in-memory
// MCP client, so what the model sees here is exactly what it sees in Open WebUI. What the chat adds
// around the model is for small local models: a budget for thinking, a last round without tools, a
// second try when a turn ends without an answer, one more try after a tool call Ollama could not
// read, and a check of the sources an answer names (citations.js).
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { checkCitations, createLedger, ledgerFromHistory } from "./citations.js";
import { createMcpServer } from "./mcp.js";
import { isEmbeddingModel } from "./setup.js";
import { UserInputError } from "./text.js";

const DEFAULT_PROMPT_FILE = new URL("../examples/system-prompt.en.md", import.meta.url);
const MAX_MESSAGE_CHARS = 20_000;
const MAX_HISTORY = 60;
const TOOL_PREVIEW_CHARS = 1200;
const RESCUE_EXCERPTS = 4;
const RESCUE_EXCERPT_CHARS = 2500;

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

export { checkCitations, createLedger };

/**
 * Whether an error from Ollama says that it could not read the tool call the model wrote
 * ("expected element type <function> but have <parameter>"). The model rarely writes the same slip twice,
 * so the round is worth asking once more.
 */
export function isUnreadableToolCall(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("expected element type") || text.includes("parsing tool call") || text.includes("error parsing tool")
    || text.includes("unexpected end of json") || text.includes("invalid character") || text.includes("unexpected eof");
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
   * and last { type: "turn", read, seen, unverified, looked, rescued, thinkCut, reasked, rounds }.
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
    const facts = { looked: false, rescued: false, thinkCut: false, reasked: 0, rounds: 0 };
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
        let result;
        for (let attempt = 1; ; attempt += 1) {
          try {
            result = yield* ask({ outgoing, offerTools, think: nudged ? false : config.chat.think, budget: nudged ? 0 : config.chat.thinkBudget });
            break;
          } catch (error) {
            // Ollama could not read the tool call the model wrote: ask this round once more instead of ending the turn.
            if (attempt > 1 || signal?.aborted || !isUnreadableToolCall(error.message)) throw error;
            log(`chat: ${error.message}; asking the round again`);
            facts.reasked += 1;
            yield { type: "retry" };
            yield { type: "note", text: "The model wrote a tool call that Ollama could not read; the round was asked again." };
          }
        }
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
          const unverified = checkCitations(content, ledger, { sources: arviro.sources("all") });
          if (unverified.length) {
            const warning = `\n\n[Arviro did not find ${unverified.map((item) => `"${item}"`).join(", ")} among the documents searched or read in this conversation; check it before relying on it.]`;
            content += warning;
            yield { type: "token", text: warning };
          }
          const assistant = { role: "assistant", content };
          history.push(assistant);
          yield { type: "message", message: assistant };
          yield { type: "turn", read: [...ledger.read.values()], seen: ledger.onlySeen(), unverified, ...facts };
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
