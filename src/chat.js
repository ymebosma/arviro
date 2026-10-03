// The chat tab: a conversation with a model served by Ollama, with the library tools.
// The tools are the same MCP tools that any chat app gets (mcp.js), reached through an in-memory
// MCP client, so what the model sees here is exactly what it sees in Open WebUI.
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp.js";
import { UserInputError } from "./text.js";

const DEFAULT_PROMPT_FILE = new URL("../examples/system-prompt.en.md", import.meta.url);
const MAX_MESSAGE_CHARS = 20_000;
const MAX_HISTORY = 60;
const TOOL_PREVIEW_CHARS = 1200;
const EMBEDDING_HINT = /embed|bge|minilm|e5-|nomic/i;

/** Models Ollama has, without the embedding models; the first one is the default. */
export async function listChatModels(url, fetchImpl = fetch) {
  const response = await fetchImpl(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Ollama answered ${response.status}`);
  const models = ((await response.json()).models || []).map((model) => String(model.name));
  return models.filter((name) => !EMBEDDING_HINT.test(name));
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

/**
 * @param {object} options
 * @param {() => object} options.getArviro
 * @param {object} options.guard   the repeat guard shared with the HTTP endpoints
 */
export function createChat({ getArviro, guard, version, log = () => {}, fetchImpl = fetch }) {
  function systemPrompt(config) {
    const file = config.chat.systemPrompt || DEFAULT_PROMPT_FILE;
    try { return fs.readFileSync(file, "utf8").trim(); }
    catch (error) { throw new Error(`The system prompt file cannot be read (${error.code || error.message}); check chat.systemPrompt.`); }
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
   * Run one turn: the model answers, calls tools as often as it needs (up to chat.maxRounds), and answers again.
   * Yields events for the page: { type: "token", text }, { type: "tool", name, args }, { type: "toolResult", name, text },
   * { type: "message", message } (an assistant or tool message to keep in the history) and { type: "done" }.
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
    const tools = await connectTools(arviro, sessionKey);
    try {
      for (let round = 0; round <= config.chat.maxRounds; round += 1) {
        const response = await fetchImpl(`${url}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: chosen, messages: history, tools: tools.definitions, stream: true, options: { num_ctx: config.chat.numCtx } }),
          signal,
        });
        if (!response.ok) {
          const text = (await response.text()).slice(0, 400);
          const detail = (() => { try { return JSON.parse(text).error; } catch { return text; } })();
          if (/does not support tools/i.test(String(detail))) throw new UserInputError(`The model "${chosen}" cannot call tools. Choose a model that can, such as qwen3 or llama3.1.`);
          if (response.status === 404) throw new UserInputError(`Ollama does not have the model "${chosen}". Pull it first: ollama pull ${chosen}`);
          throw new Error(`Ollama answered ${response.status}: ${detail}`);
        }
        let content = "";
        const toolCalls = [];
        for await (const chunk of ndjson(response.body)) {
          if (chunk.error) throw new Error(String(chunk.error));
          const message = chunk.message || {};
          if (message.content) { content += message.content; yield { type: "token", text: message.content }; }
          for (const call of message.tool_calls || []) if (call?.function?.name) toolCalls.push({ function: { name: String(call.function.name), arguments: call.function.arguments && typeof call.function.arguments === "object" ? call.function.arguments : {} } });
          if (chunk.done) break;
        }
        const assistant = { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
        history.push(assistant);
        yield { type: "message", message: assistant };
        if (!toolCalls.length) return;
        if (round === config.chat.maxRounds) {
          yield { type: "token", text: "\n\n[The model kept calling tools; the conversation was stopped here.]" };
          return;
        }
        for (const call of toolCalls) {
          const { name, arguments: args } = call.function;
          yield { type: "tool", name, args };
          let text;
          try { text = await tools.call(name, args); }
          catch (error) { text = `${name} failed: ${error.message}`; }
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
