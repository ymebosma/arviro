// Kiwix ZIM books (Wikipedia, Wikivoyage, ...) served by a local kiwix-serve process.
import { spawn } from "node:child_process";
import { cosine, PREFIX } from "./embeddings.js";
import { TOOL_SEARCH } from "./names.js";
import {
  decodeEntities, elementText, extractEntityLookup, htmlToText, levenshtein, normalizeComparable, numberedLines,
  properNamePhrases, properNames, ServiceError, STOPWORDS, stripTags, tokensFor, UserInputError,
} from "./text.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RAW_RESULT_TARGET = 25;
const MAX_PATTERNS = 8;
const MAX_ITEMS_PER_PAGE = 100;

function between(text, open, close) {
  const start = text.indexOf(open);
  if (start < 0) return null;
  const end = text.indexOf(close, start + open.length);
  return end < 0 ? null : text.slice(start + open.length, end);
}

/** Items of kiwix-serve's search results in `format=xml`. */
export function parseSearchXml(xml) {
  const text = String(xml);
  const items = [];
  let position = 0;
  while (items.length < MAX_ITEMS_PER_PAGE) {
    const start = text.indexOf("<item>", position);
    const end = start < 0 ? -1 : text.indexOf("</item>", start);
    if (end < 0) break;
    const body = text.slice(start + 6, end);
    position = end + 7;
    const title = between(body, "<title>", "</title>");
    const link = between(body, "<link>", "</link>");
    if (!title || !link) continue;
    items.push({ title: decodeEntities(title).trim(), link: decodeEntities(link).trim(), snippet: stripTags(between(body, "<description>", "</description>") || "") });
  }
  return items;
}

/** Readable lines of an article page. */
export function articleLines(html) {
  return htmlToText(elementText(html, "body") ?? html)
    .split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/**
 * @param {object} options
 * @param {{host: string, port: number, urlRoot: string, books: {name: string, file: string, sourceId: string}[]}} options.kiwix
 * @param {string|null} options.binary  path of kiwix-serve
 */
export function createKiwix({ kiwix, binary, log = () => {}, fetchImpl = fetch, spawnImpl = spawn }) {
  const origin = `http://${kiwix.host}:${kiwix.port}`;
  const base = `${origin}${kiwix.urlRoot}`;
  let child = null;
  let starting = null;

  async function healthy() {
    try {
      for (const book of kiwix.books) {
        const response = await fetchImpl(`${base}/content/${encodeURIComponent(book.name)}`, { redirect: "manual", signal: AbortSignal.timeout(3000) });
        if (response.status >= 400) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async function start() {
    if (!binary) throw new ServiceError("Kiwix books cannot be read: kiwix-serve is not installed.");
    let spawnError = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      log(`starting kiwix-serve on ${origin} with ${kiwix.books.length} book(s)`);
      const started = spawnImpl(binary, [
        `--address=${kiwix.host}`, `--port=${kiwix.port}`, `--urlRootLocation=${kiwix.urlRoot}`, "--blockexternal",
        ...kiwix.books.map((book) => book.file),
      ], { stdio: "ignore" });
      started.on("error", (error) => {
        spawnError = error;
        if (child === started) child = null;
      });
      child = started;
    }
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await healthy()) return;
      if (spawnError) {
        log(`kiwix-serve could not be started: ${spawnError.message}`);
        throw new ServiceError("Kiwix books cannot be read: kiwix-serve could not be started.");
      }
      if (!child || child.exitCode !== null || child.signalCode !== null) break;
      await sleep(250);
    }
    log(`kiwix-serve did not become ready on port ${kiwix.port}; is another program using that port?`);
    throw new ServiceError("Kiwix books cannot be read: kiwix-serve did not start.");
  }

  /** Make sure kiwix-serve answers for all books; start it when needed. An already running instance is reused. */
  async function ensure() {
    if (!kiwix.books.length) throw new ServiceError("No ZIM files are configured.");
    if (await healthy()) return;
    if (!starting) starting = start().finally(() => { starting = null; });
    await starting;
  }

  function stop() {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    child = null;
  }

  async function searchBook(book, pattern) {
    const url = `${base}/search?content=${encodeURIComponent(book.name)}&pattern=${encodeURIComponent(pattern)}&format=xml&pageLength=${RAW_RESULT_TARGET}`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    if (response.status >= 500) throw new Error(`kiwix-serve answered HTTP ${response.status}`);
    if (!response.ok) return [];
    return parseSearchXml(await response.text());
  }

  /**
   * Full-text search in the books of one source. Several patterns are tried, from most to least specific;
   * the collected results are re-ranked by embedding similarity when a query vector is available.
   */
  async function search(source, query, { queryVector = null, embedder = null, limit = 5 } = {}) {
    await ensure();
    const queryTokens = tokensFor(query).slice(0, 8);
    const keywords = queryTokens.join(" ") || query;
    const names = properNames(query).map((token) => token.toLocaleLowerCase("nl")).filter((token) => !STOPWORDS.has(token));
    const fallbackTokens = [...new Set([...names, ...queryTokens.slice().sort((a, b) => b.length - a.length)])];
    const patterns = [...new Set([extractEntityLookup(query), ...properNamePhrases(query), keywords, ...fallbackTokens].filter(Boolean))].slice(0, MAX_PATTERNS);

    const raw = [];
    const seen = new Set();
    for (const pattern of patterns) {
      for (const book of source.books) {
        for (const item of await searchBook(book, pattern)) {
          if (seen.has(item.link)) continue;
          seen.add(item.link);
          raw.push(item);
        }
      }
      if (raw.length >= RAW_RESULT_TARGET) break;
    }

    let ranked = raw.map((item) => ({ ...item, semanticScore: null }));
    let rankedByMeaning = true;
    if (raw.length && queryVector && embedder?.enabled) {
      try {
        const vectors = await embedder.embed(raw.slice(0, 40).map((item) => `${item.title}\n${item.snippet}`.slice(0, 3000)), PREFIX.encyclopedia);
        ranked = raw.slice(0, 40)
          .map((item, index) => ({ ...item, semanticScore: Number(cosine(queryVector, vectors[index]).toFixed(4)) }))
          .sort((a, b) => b.semanticScore - a.semanticScore);
      } catch (error) {
        log(`ranking of kiwix results failed: ${error.message}`);
        rankedByMeaning = false;
      }
    }
    return {
      results: ranked.slice(0, limit).map((item) => ({ title: item.title, snippet: item.snippet.slice(0, 800), link: item.link, semanticScore: item.semanticScore })),
      rankedByMeaning,
    };
  }

  async function suggestTitles(book, term, count = 30) {
    try {
      const url = `${base}/suggest?content=${encodeURIComponent(book.name)}&term=${encodeURIComponent(term)}&count=${count}`;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return [];
      return (await response.json())
        .filter((item) => item?.kind === "path" && item.value && item.path)
        .map((item) => ({ title: decodeEntities(item.value).trim(), link: `${kiwix.urlRoot}/content/${book.name}/${item.path}` }));
    } catch {
      return [];
    }
  }

  /** Article titles that differ only slightly from `subject`: used to recognise a misspelled name. */
  async function similarTitles(source, subject) {
    await ensure();
    const tokens = subject.match(/[\p{L}\p{N}'’-]+/gu) || [];
    const prefixes = new Set();
    for (const token of tokens.slice(-2)) {
      if (token.length < 4) continue;
      for (let trim = 0; trim <= 2 && token.length - trim >= 4; trim += 1) prefixes.add(token.slice(0, token.length - trim));
    }
    const titles = new Map();
    for (const book of source.books) {
      for (const prefix of prefixes) {
        for (const item of await suggestTitles(book, prefix)) titles.set(item.title, item.link);
      }
    }
    const maximumDistance = Math.max(1, Math.min(3, Math.floor(normalizeComparable(subject).length * 0.18)));
    return [...titles]
      .map(([title, link]) => ({ title, link, distance: levenshtein(subject, title) }))
      .filter((item) => item.distance <= maximumDistance)
      .sort((a, b) => a.distance - b.distance || a.title.localeCompare(b.title, "nl"))
      .slice(0, 5)
      .map(({ title, link }) => ({ title, link }));
  }

  /** Read an article as numbered text lines. `link` must be a link returned by search for this source. */
  async function read(source, link, { offset = 1, limit = 120, maxChars = 12_000 } = {}) {
    const refusal = `Use only an article link returned by ${TOOL_SEARCH} for this source.`;
    if (typeof link !== "string" || !link.startsWith("/") || link.length > 1000) throw new UserInputError(refusal);
    let url;
    let decodedPath;
    try {
      // "." and ".." are refused as path segments only: a title such as "Once Upon a Time... in Hollywood" is fine.
      if (decodeURIComponent(link).split(/[\\/]/).some((segment) => segment === "." || segment === "..")) throw new Error("dot segment");
      url = new URL(link, origin);
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      throw new UserInputError(refusal);
    }
    const allowed = source.books.some((book) => {
      const prefix = `${kiwix.urlRoot}/content/${book.name}/`;
      return decodedPath.startsWith(prefix) && decodedPath.length > prefix.length;
    });
    if (url.origin !== origin || !allowed) throw new UserInputError(refusal);

    await ensure();
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) throw new UserInputError(`This article does not exist. Use a link returned by ${TOOL_SEARCH}.`);
    if (!response.ok) throw new ServiceError("The article could not be read.");
    const html = await response.text();
    const title = stripTags(elementText(html, "title") || "") || decodedPath.split("/").at(-1);
    const lines = articleLines(html);
    const part = numberedLines(lines, offset, limit, maxChars);
    const output = [`source: ${source.id}`, `path: ${link}`, `title: ${title}`];
    if (!part.rows.length) output.push(`No lines at offset ${offset}; the article has ${lines.length} lines.`);
    else output.push(`lines: ${part.first}-${part.last} of ${lines.length}`, ...part.rows);
    if (part.rows.length && part.next) output.push(`more: continue with offset ${part.next}`);
    return { text: output.join("\n"), totalLines: lines.length, title };
  }

  return { ensure, stop, search, similarTitles, read, baseUrl: base };
}
