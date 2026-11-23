// The chat tab: a conversation with a model served by Ollama, with the library tools.
// The tools are the same MCP tools that any chat app gets (mcp.js), reached through an in-memory
// MCP client, so what the model sees here is exactly what it sees in Open WebUI. What the chat adds
// around the model is for small local models: a budget for thinking, a last round without tools, a
// second try when a turn ends without an answer, one more try for a round that returns nothing or a
// tool call Ollama could not read, a check round in which the model compares its answer with the
// question and what it found (chat.check), and a check of the sources an answer names (citations.js).
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { saysNotFound } from "./answers.js";
import { checkCitations, createLedger, ledgerFromHistory } from "./citations.js";
import { createMcpServer } from "./mcp.js";
import { isEmbeddingModel } from "./setup.js";
import { normalizeComparable, UserInputError } from "./text.js";

const DEFAULT_PROMPT_FILE = new URL("../examples/system-prompt.en.md", import.meta.url);
const MAX_MESSAGE_CHARS = 20_000;
const MAX_HISTORY = 60;
const TOOL_PREVIEW_CHARS = 1200;
const RESCUE_EXCERPTS = 4;
const RESCUE_EXCERPT_CHARS = 2500;
// The check round may look things up this many rounds more, then it has to answer.
const CHECK_ROUNDS = 3;
// A check that answers with a fraction of a full first answer ("Nothing needs to change.") did not write the answer again.
const CHECK_FULL_ANSWER = 200;

// Notes from Arviro to the model. They go with one request only and never into the conversation the page keeps.
export const NOTES = Object.freeze({
  lastRound: "(Note from Arviro, not the user: you have used all library lookups for this question. Answer now from what you found, and name your sources. Do not call any more tools.)",
  thinkSearch: "(Note from Arviro, not the user: you have thought long enough. Search the library now if you need to, or answer.)",
  thinkAnswer: "(Note from Arviro, not the user: you have thought long enough. Answer now from what you found, briefly, and name your sources.)",
  rescue: "(Note from Arviro, not the user: you cannot look anything else up. Answer the question now from these library excerpts and name your sources.)",
  // The wording that was measured on the owner's library (issue 13); change it only with a new measurement.
  check: "(Note from Arviro, not the user: check your answer before it goes out. Compare it with the question and with the passages you found. Does it answer every part of the question, with the exact numbers, names or steps from the source? If a part is missing, vague or not in a passage you saw, look it up once more with search_library or read_document. Then write the complete final answer again, in the language of the question, with its source. If nothing needs to change, repeat your answer unchanged.)",
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
   * { type: "draft", message } (the answer so far goes through the check round; the final message replaces it),
   * and last { type: "turn", read, seen, unverified, looked, rescued, thinkCut, reasked, checked, checkChanged, checkSetAside, rounds }
   * (and checkAnswer, what the check wrote, when it was set aside).
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
    const facts = { looked: false, rescued: false, thinkCut: false, reasked: 0, checked: false, checkChanged: false, checkSetAside: false, rounds: 0 };
    // What the check round wrote when it was set aside, for `arviro eval`.
    let setAside = null;
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
      let limit = config.chat.maxRounds;
      // The check round: the first answer, where it stands in the conversation, and whether the check looked anything up.
      let check = null;
      for (let round = 0; ; round += 1) {
        facts.rounds = round + 1;
        const last = round >= limit;
        const answerNow = note === NOTES.thinkAnswer;
        // The last round has no tools: a model that would go on looking things up has to answer.
        if (last && !note) note = NOTES.lastRound;
        const offerTools = !last && !answerNow;
        // During the check the model sees its first answer and the request to check it; neither is kept in the conversation.
        const base = check ? [...history.slice(0, check.at), { role: "assistant", content: check.first }, { role: "user", content: NOTES.check }, ...history.slice(check.at)] : history;
        const outgoing = note ? [...base, { role: "user", content: note }] : base;
        const nudged = Boolean(note);
        note = null;
        // The check round has its own settings for thinking: it thinks to the budget more often than a first answer.
        const thinking = check
          ? { think: config.chat.checkThink ?? config.chat.think, budget: config.chat.checkThinkBudget, setting: "chat.checkThinkBudget" }
          : { think: config.chat.think, budget: config.chat.thinkBudget, setting: "chat.thinkBudget" };
        let result;
        for (let attempt = 1; ; attempt += 1) {
          try {
            result = yield* ask({ outgoing, offerTools, think: nudged ? false : thinking.think, budget: nudged ? 0 : thinking.budget });
          } catch (error) {
            // The check is an extra: when it fails, the first answer stands.
            if (check && !signal?.aborted && (attempt > 1 || !isUnreadableToolCall(error.message))) {
              log(`chat: the check round failed: ${error.message}`);
              result = { content: "", toolCalls: [], doneReason: null, cut: false };
              break;
            }
            // Ollama could not read the tool call the model wrote: ask this round once more instead of ending the turn.
            if (attempt > 1 || signal?.aborted || !isUnreadableToolCall(error.message)) throw error;
            log(`chat: ${error.message}; asking the round again`);
            facts.reasked += 1;
            yield { type: "retry" };
            yield { type: "note", text: "The model wrote a tool call that Ollama could not read; the round was asked again." };
            continue;
          }
          // Nothing at all came back before any lookup: no text, no tool call, no error. A second try with what
          // the model found does not apply yet, so the round itself is asked once more.
          const nothing = !result.cut && !facts.looked && result.doneReason !== "length" && !(offerTools && result.toolCalls.length) && isEmptyAnswer(result.content);
          if (attempt > 1 || !nothing || signal?.aborted) break;
          log("chat: the model returned nothing; asking the round again");
          facts.reasked += 1;
          yield { type: "retry" };
          yield { type: "note", text: "The model returned nothing; the round was asked again." };
        }
        if (result.cut) {
          facts.thinkCut = true;
          yield { type: "note", text: `Thinking was stopped after ${thinking.budget} tokens (${thinking.setting}); the model was asked to go on without it.` };
          note = (check ? check.looked : facts.looked) ? NOTES.thinkAnswer : NOTES.thinkSearch;
          continue;
        }
        // A lookup asked for in a round without tools is not run.
        const toolCalls = offerTools ? result.toolCalls : [];
        let { content, doneReason } = result;

        if (!toolCalls.length && check) {
          // The answer of the check round is the answer, unless it is none: empty, cut off, or a remark instead of the answer written again.
          const first = check.first.trim();
          const usable = !isEmptyAnswer(content) && doneReason !== "length" && !(first.length >= CHECK_FULL_ANSWER && content.trim().length * 3 < first.length);
          if (usable) facts.checkChanged = normalizeComparable(content) !== normalizeComparable(first);
          else {
            facts.checkSetAside = true;
            setAside = content;
            content = check.first;
            yield { type: "retry" };
            yield { type: "note", text: "The check gave no full answer; the first answer stands." };
            yield { type: "token", text: content };
          }
        } else if (!toolCalls.length) {
          if (isEmptyAnswer(content) && facts.looked) {
            const second = yield* rescue();
            if (second) {
              facts.rescued = true;
              ({ content, doneReason } = second);
            }
          }
          let complete = true;
          // The model ran out of room (chat.numPredict): say so, instead of ending the turn with silence.
          if (doneReason === "length") {
            const ending = content.trim()
              ? "\n\n[The answer was cut off at chat.numPredict tokens.]"
              : "[The model used up its room on thinking and gave no answer. Try again, or set chat.think to false.]";
            content += ending;
            complete = false;
            yield { type: "token", text: ending };
          } else if (isEmptyAnswer(content)) {
            const ending = "[The model gave no answer. Try again, or try another model.]";
            content = ending;
            complete = false;
            yield { type: "retry" };
            yield { type: "token", text: ending };
          }
          // The check round (chat.check): the model compares its answer with the question and what it found, and may
          // look things up once more. Always after an answer that says something was not found; in the mode "always"
          // after every answer the model looked something up for (a greeting has nothing to check against).
          if (complete && config.chat.check !== "off" && (saysNotFound(content) || (config.chat.check === "always" && facts.looked))) {
            check = { at: history.length, first: content, looked: false };
            facts.checked = true;
            limit = round + CHECK_ROUNDS + 1;
            yield { type: "draft", message: { role: "assistant", content } };
            yield { type: "note", text: "The model was asked to check its answer against the question and what it found (chat.check)." };
            continue;
          }
        }
        if (!toolCalls.length) {
          const unverified = checkCitations(content, ledger, { sources: arviro.sources("all") });
          if (unverified.length) {
            const warning = `\n\n[Arviro did not find ${unverified.map((item) => `"${item}"`).join(", ")} among the documents searched or read in this conversation; check it before relying on it.]`;
            content += warning;
            yield { type: "token", text: warning };
          }
          const assistant = { role: "assistant", content };
          history.push(assistant);
          yield { type: "message", message: assistant };
          yield { type: "turn", read: [...ledger.read.values()], seen: ledger.onlySeen(), unverified, ...facts, ...(facts.checkSetAside ? { checkAnswer: setAside } : {}) };
          return;
        }

        const assistant = { role: "assistant", content, tool_calls: toolCalls };
        history.push(assistant);
        yield { type: "message", message: assistant };
        facts.looked = true;
        if (check) check.looked = true;
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
