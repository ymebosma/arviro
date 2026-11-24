// Hybrid search over indexed documents: SQLite full-text (BM25) fused with embedding similarity.
import { asciiLower, ftsQuery, normalizeComparable, tokensFor } from "./text.js";

const LEXICAL_CANDIDATES = 80;
const SEMANTIC_CANDIDATES = 120;
const MAX_PASSAGES_PER_DOCUMENT = 2;
// A query word that only a few documents hold is strong evidence: at most this many documents, and at most this
// share of the documents searched (one document always counts).
const RARE_DOCUMENTS = 3;
const RARE_SHARE = 0.05;
// The best passage for each of this many rare words comes before the passages that match by meaning alone.
const RARE_WORDS = 2;

export function createDocumentSearch(db) {
  let cache = null;

  // All embeddings in one Float32Array, reloaded when another process has changed the index.
  // Runs inside the read transaction of the search that needs it.
  function vectors() {
    const version = db.prepare("PRAGMA data_version").get().data_version;
    if (cache?.version === version) return cache;
    const sources = new Map(db.prepare("SELECT id, corpus, path, content_path FROM sources").all().map((row) => [Number(row.id), row]));
    const count = Number(db.prepare("SELECT count(*) AS n FROM chunks").get().n);
    const first = db.prepare("SELECT embedding FROM chunks WHERE length(embedding) > 0 LIMIT 1").get();
    const dimensions = first ? first.embedding.byteLength / 4 : 0;
    const ids = new Int32Array(count);
    const sourceIds = new Int32Array(count);
    const norms = new Float32Array(count);
    const matrix = new Float32Array(count * dimensions);
    let index = 0;
    for (const row of db.prepare("SELECT id, source_id, embedding FROM chunks").iterate()) {
      if (index >= count) break;
      ids[index] = Number(row.id);
      sourceIds[index] = Number(row.source_id);
      const bytes = row.embedding;
      if (dimensions && bytes.byteLength === dimensions * 4) {
        const values = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        matrix.set(values, index * dimensions);
        let sum = 0;
        for (const value of values) sum += value * value;
        norms[index] = Math.sqrt(sum);
      }
      index += 1;
    }
    cache = { version, sources, count: index, dimensions, ids, sourceIds, norms, matrix };
    return cache;
  }

  function semanticCandidates(store, queryVector, isAllowed) {
    let queryNorm = 0;
    for (const value of queryVector) queryNorm += value * value;
    queryNorm = Math.sqrt(queryNorm) || 1;
    const allowedSource = new Map();
    const scored = [];
    for (let index = 0; index < store.count; index += 1) {
      if (!store.norms[index]) continue;
      const sourceId = store.sourceIds[index];
      let allowed = allowedSource.get(sourceId);
      if (allowed === undefined) {
        const source = store.sources.get(sourceId);
        allowed = Boolean(source && isAllowed(source));
        allowedSource.set(sourceId, allowed);
      }
      if (!allowed) continue;
      const offset = index * store.dimensions;
      let dot = 0;
      for (let d = 0; d < store.dimensions; d += 1) dot += queryVector[d] * store.matrix[offset + d];
      scored.push({ id: store.ids[index], similarity: dot / (queryNorm * store.norms[index]) });
    }
    return scored.sort((a, b) => b.similarity - a.similarity).slice(0, SEMANTIC_CANDIDATES);
  }

  /**
   * The best passage for each query word that only a few of the searched documents hold (a name, a model number,
   * a rare noun): the ids of at most RARE_WORDS passages, rarest word first. Counting stops at RARE_DOCUMENTS + 1
   * documents, so a common word costs little.
   */
  function rarePassages(queryTerms, filters, filterValues) {
    const where = filters.length ? ` AND ${filters.join(" AND ")}` : "";
    const matching = `FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid JOIN sources s ON s.id=c.source_id WHERE chunks_fts MATCH ?${where}`;
    const total = Number(db.prepare(`SELECT count(*) AS n FROM sources s${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}`).get(...filterValues).n);
    const few = Math.min(RARE_DOCUMENTS, Math.max(1, Math.ceil(total * RARE_SHARE)));
    const countDocuments = db.prepare(`SELECT count(*) AS n FROM (SELECT DISTINCT c.source_id ${matching} LIMIT ${RARE_DOCUMENTS + 1})`);
    const bestPassage = db.prepare(`SELECT c.id, bm25(chunks_fts, 1.0, 2.5, 1.5) AS score ${matching} ORDER BY score LIMIT 1`);
    const rare = [];
    for (const term of queryTerms) {
      const match = ftsQuery(term);
      if (!match) continue;
      const documents = Number(countDocuments.get(match, ...filterValues).n);
      if (documents >= 1 && documents <= few) rare.push({ documents, id: Number(bestPassage.get(match, ...filterValues).id) });
    }
    return new Set(rare.sort((a, b) => a.documents - b.documents).slice(0, RARE_WORDS).map((item) => item.id));
  }

  /**
   * @param {object} options
   * @param {string} options.query          text used for matching and ranking
   * @param {number[]|null} options.queryVector  embedding of the query, or null for full-text search only
   * @param {string[]} options.corpora      source ids to search
   * @param {string|null} options.pathPrefix  only this folder (or this exact file)
   * @param {number|null} options.minSemanticScore  passages without a literal term match need at least this similarity
   * @returns {{ results: object[], embeddingMismatch: boolean }}  embeddingMismatch: the index holds no
   *   embeddings of the query vector's size, so only literal matches were used
   */
  function search({ query, queryVector = null, limit = 8, corpora = [], pathPrefix = null, minSemanticScore = null }) {
    const queryTerms = tokensFor(query);
    const filters = [];
    const filterValues = [];
    if (corpora.length) {
      filters.push(`s.corpus IN (${corpora.map(() => "?").join(",")})`);
      filterValues.push(...corpora);
    }
    // A folder filter matches whole path segments: "manuals" covers "manuals/x" but not "manuals-old/x".
    const prefix = pathPrefix ? asciiLower(pathPrefix) : null;
    const folder = prefix ? `${prefix}/` : null;
    if (prefix) {
      const within = (column) => `(lower(${column}) = ? OR substr(lower(${column}), 1, ?) = ?)`;
      filters.push(`(${within("s.path")} OR ${within("s.content_path")})`);
      const values = [prefix, [...folder].length, folder];
      filterValues.push(...values, ...values);
    }
    const inFolder = (value) => {
      const lowered = asciiLower(value);
      return lowered === prefix || lowered.startsWith(folder);
    };
    const isAllowed = (source) => (!corpora.length || corpora.includes(source.corpus))
      && (!prefix || inFolder(source.path) || inFolder(source.content_path));

    // One read transaction, so the cached embeddings and the rows fetched below belong to the same state of the index.
    db.exec("BEGIN");
    try {
      const store = vectors();
      const embeddingMismatch = Boolean(queryVector) && store.count > 0 && store.dimensions !== queryVector.length;
      const match = ftsQuery(query);
      const lexical = match ? db.prepare(`
        SELECT c.id, bm25(chunks_fts, 1.0, 2.5, 1.5) AS score
        FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid JOIN sources s ON s.id=c.source_id
        WHERE chunks_fts MATCH ?${filters.length ? ` AND ${filters.join(" AND ")}` : ""} ORDER BY score LIMIT ${LEXICAL_CANDIDATES}
      `).all(match, ...filterValues) : [];
      const lexicalRanks = new Map(lexical.map((row, index) => [Number(row.id), index + 1]));
      const promoted = rarePassages(queryTerms, filters, filterValues);
      // A promoted passage is a literal hit by definition; with many other words in the query it can fall outside the list.
      for (const id of promoted) if (!lexicalRanks.has(id)) lexicalRanks.set(id, LEXICAL_CANDIDATES);
      const semantic = queryVector && !embeddingMismatch ? semanticCandidates(store, queryVector, isAllowed) : [];
      const semanticRanks = new Map(semantic.map((row, index) => [row.id, { rank: index + 1, similarity: row.similarity }]));

      // Reciprocal rank fusion, slightly favouring meaning over literal matches. On its own that puts the best
      // literal-only passage behind fourteen meaning-only ones, and the embedding of a short query is often
      // confidently wrong; so the best passage for a rare word counts as the best match by meaning too.
      const fused = [...new Set([...lexicalRanks.keys(), ...semanticRanks.keys()])].map((id) => {
        const lexicalRank = lexicalRanks.get(id);
        const semanticRank = semanticRanks.get(id);
        return {
          id,
          score: (lexicalRank ? 0.45 / (60 + lexicalRank) : 0) + (promoted.has(id) ? 0.55 / 61 : semanticRank ? 0.55 / (60 + semanticRank.rank) : 0),
          similarity: semanticRank?.similarity ?? null,
        };
      }).sort((a, b) => b.score - a.score);

      const get = db.prepare("SELECT c.*, s.corpus, s.path, s.content_path, s.kind, s.title FROM chunks c JOIN sources s ON s.id=c.source_id WHERE c.id=?");
      const results = [];
      const perDocument = new Map();
      for (const candidate of fused) {
        const row = get.get(candidate.id);
        if (!row || !isAllowed(row)) continue;
        const normalizedContent = normalizeComparable(`${row.title}\n${row.content}`);
        const matchedTerms = queryTerms.filter((term) => normalizedContent.includes(normalizeComparable(term)));
        const lexicalMatch = matchedTerms.length > 0;
        if (!lexicalMatch && minSemanticScore != null && (candidate.similarity == null || candidate.similarity < minSemanticScore)) continue;
        const key = `${row.corpus}:${row.path}`;
        if ((perDocument.get(key) || 0) >= MAX_PASSAGES_PER_DOCUMENT) continue;
        perDocument.set(key, (perDocument.get(key) || 0) + 1);
        results.push({
          corpus: row.corpus,
          path: row.path,
          title: row.title,
          kind: row.kind,
          page: row.page,
          lines: row.line_start ? `${row.line_start}-${row.line_end}` : null,
          lineStart: row.line_start,
          lexicalMatch,
          matchedTerms: matchedTerms.slice(0, 5),
          semanticScore: candidate.similarity == null ? null : Number(candidate.similarity.toFixed(4)),
          excerpt: row.content.slice(0, 1200),
        });
        if (results.length >= limit) break;
      }
      return { results, embeddingMismatch };
    } finally {
      db.exec("COMMIT");
    }
  }

  return { search };
}
