// The application: search and read across the configured sources.
import fs from "node:fs";
import { sourcesInScope } from "./config.js";
import { openIndexForRead, readMeta } from "./db.js";
import { createDocumentSearch } from "./documents.js";
import { createEmbedder, PREFIX } from "./embeddings.js";
import { buildEvidence } from "./evidence.js";
import { createKiwix } from "./kiwix.js";
import { TOOL_READ } from "./names.js";
import { createOsmSearch } from "./osm.js";
import { readDocument } from "./reader.js";
import { normalizeComparable, normalizePathPrefix, ServiceError, UserInputError } from "./text.js";

const POLICY = Object.freeze({
  found: `These results are locations, not answers. If the excerpt is not enough, read only the single most relevant result with ${TOOL_READ}, passing its \`read\` arguments unchanged.`,
  foundMaps: "Copy names, coordinates and distances exactly as given; do not calculate distances yourself.",
  none: "Nothing relevant was found in this source. Treat that as the result: tell the user it is not in this source. Do not keep trying synonyms, translations or other sources unless the user asks.",
  unavailable: "This source could not be searched. Tell the user; do not retry.",
  entityVerified: `A source with exactly this name was found (evidence.requiredSource). Answer only from that source; read it with ${TOOL_READ} if the excerpt is not enough.`,
  entityAmbiguous: "No source has exactly this name. Do not answer from the results; ask the user which of evidence.candidates they mean.",
  entityNotFound: "No source confirms this name. Say that you cannot confirm it in this source; do not answer from loosely related results.",
});

const WARNING = Object.freeze({
  noMeaning: "Search by meaning is unavailable right now; only literal word matches were used.",
  staleIndex: "The index was built with other embedding settings, so only literal word matches were used. The owner should run the index command.",
  notRanked: "The results are in the order the encyclopedia returned them, not ranked by meaning.",
});

/** For a who-is question the evidence verdict decides what the model should do with the results. */
function policyFor(evidence, fallback) {
  if (evidence.mode !== "entity") return fallback;
  if (evidence.status === "verified") return POLICY.entityVerified;
  if (evidence.status === "ambiguous") return POLICY.entityAmbiguous;
  if (evidence.status === "not_found") return POLICY.entityNotFound;
  return fallback;
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

/** Add the configured cross-language terms to a question (for example Dutch question, English documents). */
export function expandQuery(query, expansions) {
  const normalized = normalizeComparable(query);
  const additions = expansions.filter(({ pattern }) => pattern.test(normalized)).map(({ add }) => add);
  return additions.length ? `${query}\n${[...new Set(additions)].join(" ")}` : query;
}

/** The folder a question is routed to by a source's `routes`, or "". */
export function inferPrefix(routes, query) {
  const lower = query.toLocaleLowerCase("nl");
  return routes.find((route) => route.terms.some((term) => lower.includes(term)))?.prefix || "";
}

/**
 * @param {object} config  normalized configuration (see config.js)
 * @param {object} [overrides]  embedder and kiwix can be replaced in tests
 */
export function createArviro(config, { embedder = createEmbedder(config.embedding), kiwix = null, log = () => {} } = {}) {
  const kiwixService = kiwix || createKiwix({ kiwix: config.kiwix, binary: config.tools.kiwixServe, log });
  let index = null;

  function openIndex() {
    if (index) return index;
    const db = openIndexForRead(config.indexPath);
    if (!db) throw new ServiceError("The search index has not been built yet. The owner should run the index command.");
    index = { db, documents: createDocumentSearch(db), osm: createOsmSearch(db) };
    return index;
  }

  function sources(scope = "all") {
    return sourcesInScope(config, scope);
  }

  function resolveSource(id, scope) {
    const available = sources(scope);
    const source = available.find((candidate) => candidate.id === id);
    if (!source) throw new UserInputError(`Unknown source "${id}". Available sources: ${available.map((candidate) => candidate.id).join(", ")}.`);
    return source;
  }

  /** The embedding of a question, or null (with a warning for the model) when search by meaning is not possible. */
  async function embedQuery(text, warnings) {
    if (!embedder.enabled) return null;
    try {
      return (await embedder.embed([text], PREFIX.query))[0];
    } catch (error) {
      log(`query embedding failed: ${error.message}`);
      warnings.push(WARNING.noMeaning);
      return null;
    }
  }

  async function searchDocuments(source, query, pathPrefix, limit, warnings) {
    const { db, documents } = openIndex();
    let prefix = normalizePathPrefix(pathPrefix);
    let inferred = false;
    if (!prefix) {
      prefix = inferPrefix(source.routes, query);
      inferred = Boolean(prefix);
    }
    const retrievalQuery = source.expandQueries ? expandQuery(query, config.search.queryExpansions) : query;
    // Embeddings of another model cannot be compared with the question's embedding.
    const sameModel = !embedder.enabled || readMeta(db).model === embedder.model;
    const queryVector = sameModel ? await embedQuery(retrievalQuery, warnings) : null;
    const run = (activePrefix) => documents.search({
      query: retrievalQuery,
      queryVector,
      limit,
      corpora: [source.id],
      pathPrefix: activePrefix || null,
      minSemanticScore: config.search.minSemanticScore,
    });
    let found = run(prefix);
    if (!found.results.length && inferred) {
      prefix = "";
      found = run("");
    }
    if (!sameModel || found.embeddingMismatch) warnings.push(WARNING.staleIndex);
    const results = found.results.map((item) => ({
      title: item.title,
      kind: item.kind,
      ...(item.page ? { page: item.page } : {}),
      ...(item.lines ? { lines: item.lines } : {}),
      excerpt: item.excerpt,
      read: { source: source.id, path: item.path, offset: item.page || item.lineStart || 1 },
    }));
    const evidence = buildEvidence(query, found.results.map((item) => ({ source: source.id, title: item.title, path: item.path })));
    return { results, evidence, appliedPathPrefix: prefix || null, policy: results.length ? POLICY.found : POLICY.none };
  }

  async function searchKiwix(source, query, limit, warnings) {
    const queryVector = await embedQuery(query, warnings);
    let found;
    try {
      found = await kiwixService.search(source, query, { queryVector, embedder, limit });
    } catch (error) {
      log(`${source.id} search failed: ${error.message}`);
      warnings.push(error instanceof ServiceError ? `${source.id} is not available: ${error.message}` : `${source.id} is not available right now.`);
      const evidence = buildEvidence(query, []);
      if (evidence.mode === "entity") evidence.status = "unavailable";
      return { results: [], evidence, policy: POLICY.unavailable };
    }
    if (!found.rankedByMeaning && !warnings.includes(WARNING.noMeaning)) warnings.push(WARNING.notRanked);
    const evidence = buildEvidence(query, found.results.map((item) => ({ source: source.id, title: item.title, path: item.link, encyclopedia: true })));
    if (evidence.mode === "entity" && evidence.status === "not_found") {
      const similar = await kiwixService.similarTitles(source, evidence.subject).catch(() => []);
      if (similar.length) {
        evidence.status = "ambiguous";
        evidence.candidates = similar.map((item) => ({ source: source.id, title: item.title, path: item.link }));
      }
    }
    const results = found.results.map((item) => ({ title: item.title, snippet: item.snippet, read: { source: source.id, path: item.link } }));
    return { results, evidence, policy: results.length ? POLICY.found : POLICY.none };
  }

  /**
   * Search one source.
   * @param {{ query: string, source: string, pathPrefix?: string, limit?: number }} request
   * @param {"all"|"public"} scope
   */
  async function search({ query, source: sourceId, pathPrefix = "", limit = 5 }, scope = "all") {
    const source = resolveSource(sourceId, scope);
    const text = String(query || "").trim();
    if (text.length < 2 || text.length > 500) throw new UserInputError("The query must be between 2 and 500 characters.");
    const maximum = clampInteger(limit, 1, 10, 5);
    const warnings = [];
    let outcome;
    if (source.type === "documents") outcome = await searchDocuments(source, text, pathPrefix, maximum, warnings);
    else if (source.type === "kiwix") outcome = await searchKiwix(source, text, maximum, warnings);
    else {
      const results = openIndex().osm.search(text, { limit: maximum, regions: Object.keys(source.regions) });
      outcome = { results, evidence: { mode: "general" }, policy: results.length ? POLICY.foundMaps : POLICY.none };
    }
    return {
      query: text,
      source: source.id,
      ...(outcome.appliedPathPrefix ? { appliedPathPrefix: outcome.appliedPathPrefix } : {}),
      ...(outcome.evidence.mode === "entity" ? { evidence: outcome.evidence } : {}),
      results: outcome.results,
      ...(warnings.length ? { warnings } : {}),
      resultPolicy: policyFor(outcome.evidence, outcome.policy),
    };
  }

  /**
   * Read more of a search result.
   * @param {{ source: string, path: string, offset?: number, limit?: number }} request
   * @returns {Promise<{ text: string }>}
   */
  async function read({ source: sourceId, path: requestedPath, offset = 1, limit = 120 }, scope = "all") {
    const source = resolveSource(sourceId, scope);
    const bounds = { offset: clampInteger(offset, 1, 1_000_000, 1), limit: clampInteger(limit, 1, 160, 120), maxChars: config.read.maxChars };
    if (source.type === "documents") return readDocument(source, requestedPath, { ...bounds, pdftotext: config.tools.pdftotext });
    if (source.type === "kiwix") return kiwixService.read(source, requestedPath, bounds);
    throw new UserInputError("Map results cannot be read further; use the name and coordinates from the search result.");
  }

  /** What is configured and indexed; used by the status and doctor commands. */
  function status() {
    const result = {
      config: config.configPath,
      embedding: { provider: config.embedding.provider, model: config.embedding.model, dimensions: config.embedding.dimensions },
      sources: Object.values(config.sources).map((source) => ({
        id: source.id,
        type: source.type,
        private: source.private,
        description: source.description,
        ...(source.type === "documents" ? { path: source.root, exists: fs.existsSync(source.root) } : {}),
        ...(source.type === "kiwix" ? { books: source.books.map((book) => book.name) } : {}),
        ...(source.type === "maps" ? { regions: Object.keys(source.regions) } : {}),
      })),
      index: { path: config.indexPath, exists: fs.existsSync(config.indexPath) },
    };
    if (!result.index.exists) return result;
    const { db } = openIndex();
    const meta = readMeta(db);
    Object.assign(result.index, {
      bytes: fs.statSync(config.indexPath).size,
      model: meta.model || null,
      dimensions: meta.dimensions === undefined ? null : Number(meta.dimensions),
      updatedAt: meta.updated_at || null,
      buildStatus: meta.build_status || null,
      documents: db.prepare("SELECT s.corpus AS source, count(DISTINCT s.id) AS documents, count(c.id) AS passages FROM sources s LEFT JOIN chunks c ON c.source_id=s.id GROUP BY s.corpus ORDER BY s.corpus").all().map((row) => ({ ...row })),
      maps: db.prepare("SELECT region, count(*) AS objects FROM osm_objects GROUP BY region ORDER BY region").all().map((row) => ({ ...row })),
    });
    return result;
  }

  function close() {
    kiwixService.stop();
    if (index) index.db.close();
    index = null;
  }

  return { config, sources, search, read, status, close, kiwix: kiwixService };
}
