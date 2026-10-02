// Embeddings through Ollama's /api/embed, or none at all (full-text search only).

// Instruction prefixes for the embedding model. Changing a prefix requires re-indexing.
export const PREFIX = Object.freeze({
  document: "Represent this multilingual document passage for cross-language retrieval: ",
  query: "Represent this multilingual query for cross-language information retrieval: ",
  encyclopedia: "Represent this multilingual encyclopedia search result for cross-language retrieval: ",
});

/** Embedding stored in the index as raw little-endian float32 values. */
export function vectorToBlob(vector) {
  const typed = Float32Array.from(vector);
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return -1;
  let dot = 0, normA = 0, normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] ** 2;
    normB += b[index] ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @returns {{ enabled: boolean, model: string, embed(inputs: string[], prefix: string, options?: object): Promise<number[][]> }}
 */
export function createEmbedder(embedding, { fetchImpl = fetch } = {}) {
  if (embedding.provider === "none") {
    return { enabled: false, model: "none", async embed() { throw new Error("Embeddings are disabled."); } };
  }

  async function request(inputs, prefix, timeoutMs) {
    const response = await fetchImpl(`${embedding.url}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: embedding.model, input: inputs.map((value) => `${prefix}${value}`), dimensions: embedding.dimensions, truncate: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Ollama embedding error ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const body = await response.json();
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== inputs.length) throw new Error("Ollama returned no valid embeddings.");
    return body.embeddings;
  }

  let failuresInARow = 0;

  /**
   * options.attempts: tries per batch (default 1, for interactive use; the indexer uses more).
   * options.tolerant: for index builds. A batch that keeps failing is split in two, down to single
   * passages; a passage that cannot be embedded gets `null` instead of stopping the build.
   * Three such passages in a row mean the service itself is failing, and that does stop it.
   */
  async function embed(inputs, prefix, { attempts = 1, timeoutMs = 30_000, tolerant = false } = {}) {
    if (!inputs.length) return [];
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const vectors = await request(inputs, prefix, timeoutMs);
        failuresInARow = 0;
        return vectors;
      } catch (error) {
        lastError = error;
        if (attempt < attempts - 1) await sleep(1000 * (attempt + 1));
      }
    }
    if (!tolerant) throw lastError;
    if (inputs.length > 1) {
      const middle = Math.ceil(inputs.length / 2);
      const options = { attempts: Math.min(attempts, 2), timeoutMs, tolerant };
      return [...await embed(inputs.slice(0, middle), prefix, options), ...await embed(inputs.slice(middle), prefix, options)];
    }
    failuresInARow += 1;
    if (failuresInARow >= 3) throw new Error(`The embedding service keeps failing: ${lastError.message}`);
    return [null];
  }

  return { enabled: true, model: embedding.model, embed };
}
