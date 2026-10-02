import assert from "node:assert/strict";
import test from "node:test";
import { cosine, createEmbedder, vectorToBlob } from "../src/embeddings.js";

const settings = { provider: "ollama", url: "http://ollama.test", model: "test-model", dimensions: 2 };

/** A stand-in for Ollama's /api/embed that fails for every batch containing a text with "BAD". */
function fakeOllama({ alwaysFail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, { body }) => {
    const { input, model, dimensions } = JSON.parse(body);
    calls.push(input.length);
    assert.equal(url, "http://ollama.test/api/embed");
    assert.deepEqual([model, dimensions], ["test-model", 2]);
    if (alwaysFail || input.some((text) => text.includes("BAD"))) return { ok: false, status: 500, text: async () => "model runner crashed" };
    return { ok: true, json: async () => ({ embeddings: input.map((text) => [text.length, 1]) }) };
  };
  return { calls, fetchImpl };
}

test("cosine and vectorToBlob", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0], [1, 0, 0]), -1);
  assert.equal(vectorToBlob([1, 2]).byteLength, 8);
});

test("the instruction prefix is put in front of every text", async () => {
  const { fetchImpl } = fakeOllama();
  const embedder = createEmbedder(settings, { fetchImpl });
  assert.deepEqual(await embedder.embed(["abc"], "Q: "), [[6, 1]]);
  assert.deepEqual(await embedder.embed([], "Q: "), []);
});

test("a question that cannot be embedded is an error, without retries", async () => {
  const { calls, fetchImpl } = fakeOllama({ alwaysFail: true });
  const embedder = createEmbedder(settings, { fetchImpl });
  await assert.rejects(embedder.embed(["abc"], ""), /Ollama embedding error 500/);
  assert.deepEqual(calls, [1]);
});

test("during an index build one bad passage gets no embedding and the rest goes on", async () => {
  const { fetchImpl } = fakeOllama();
  const embedder = createEmbedder(settings, { fetchImpl });
  const vectors = await embedder.embed(["one", "two", "BAD passage", "four", "five"], "", { attempts: 1, tolerant: true });
  assert.deepEqual(vectors, [[3, 1], [3, 1], null, [4, 1], [4, 1]]);
});

test("during an index build a service that keeps failing stops the build", async () => {
  const { fetchImpl } = fakeOllama({ alwaysFail: true });
  const embedder = createEmbedder(settings, { fetchImpl });
  await assert.rejects(embedder.embed(["one", "two", "three", "four", "five", "six"], "", { attempts: 1, tolerant: true }), /embedding service keeps failing/);
});

test("without a provider nothing is embedded", async () => {
  const embedder = createEmbedder({ provider: "none", model: "none" });
  assert.equal(embedder.enabled, false);
  await assert.rejects(embedder.embed(["abc"], ""));
});
