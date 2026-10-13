// Library management for the owner: downloads ZIM books and map extracts from the list in the configuration,
// checks their checksums and keeps track of what is in the library and how old it is.
// Nothing here is reachable by the model; Arviro's tools stay read-only.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { discoverBooks, zimSeries } from "./config.js";
import { decodeEntities, UserInputError } from "./text.js";

const USER_AGENT = "arviro-library (https://github.com/ymebosma/arviro)";
const MAX_SMALL_RESPONSE = 4 * 1024 * 1024;
const SMALL_TIMEOUT_MS = 30_000;
const STALL_MS = 60_000;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;
const ACQUISITION_REL = "http://opds-spec.org/acquisition/open-access";
const ALGORITHMS = { md5: "md5", sha1: "sha1", "sha-1": "sha1", sha256: "sha256", "sha-256": "sha256" };
const ALGORITHM_BY_LENGTH = { 32: "md5", 40: "sha1", 64: "sha256" };
const ZIM_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zim$/;
const DAY_MS = 24 * 60 * 60 * 1000;

class ChecksumError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The edition date in a ZIM name ("2026-04" in "wikipedia_nl_all_nopic_2026-04"), or null. */
export function zimEdition(name) {
  return String(name).replace(/\.zim$/, "").match(/_(\d{4}-\d{2}(?:-\d{2})?)$/)?.[1] || null;
}

/**
 * The elements named `name` in a small XML document: their attributes and inner text.
 * Scans with indexOf, so it stays linear on any input. Namespaced names ("dc:issued") are matched as given.
 */
export function xmlElements(xml, name) {
  const text = String(xml);
  const found = [];
  let position = 0;
  while (position < text.length) {
    const start = text.indexOf(`<${name}`, position);
    if (start < 0) break;
    const next = text[start + name.length + 1];
    if (next !== undefined && /[A-Za-z0-9:_.-]/.test(next)) { position = start + 1; continue; }
    const open = text.indexOf(">", start);
    if (open < 0) break;
    const tag = text.slice(start, open + 1);
    const attributes = {};
    for (const match of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) attributes[match[1]] = decodeEntities(match[2]);
    if (tag.endsWith("/>")) { found.push({ attributes, body: "" }); position = open + 1; continue; }
    const end = text.indexOf(`</${name}`, open);
    if (end < 0) break;
    found.push({ attributes, body: text.slice(open + 1, end) });
    position = end + name.length + 3;
  }
  return found;
}

const firstText = (xml, name) => decodeEntities(xmlElements(xml, name)[0]?.body ?? "").trim() || null;

/** The ZIM file an OPDS entry links to: { file, url, meta4Url, bytes }, or null. */
export function acquisitionOf(entryXml, base = "https://library.kiwix.org/") {
  const link = xmlElements(entryXml, "link").map((item) => item.attributes).find((candidate) => candidate.rel === ACQUISITION_REL || candidate.type === "application/x-zim");
  if (!link?.href) return null;
  let url;
  let file;
  try {
    const href = new URL(link.href, base).href;
    url = href.endsWith(".meta4") ? href.slice(0, -6) : href;
    file = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
  } catch { return null; }
  // The file name decides where a download is written, so it must be a plain ZIM name.
  if (!ZIM_FILE.test(file)) return null;
  return { file, url, meta4Url: `${url}.meta4`, bytes: Number(link.length) > 0 ? Number(link.length) : null };
}

/**
 * The latest edition of a book in a Kiwix OPDS catalogue feed (`/catalog/v2/entries?name=...`).
 * A book is identified by the series of its file name ("wikipedia_nl_all_nopic"): the catalogue's own
 * `<name>` leaves the flavour out ("wikipedia_nl_all", with `<flavour>nopic</flavour>`).
 * Returns { file, bytes, url, meta4Url, updated } or null when the book is not in the feed.
 */
export function parseCatalog(xml, name, base = "https://library.kiwix.org/") {
  for (const entry of xmlElements(xml, "entry")) {
    const acquisition = acquisitionOf(entry.body, base);
    if (!acquisition || zimSeries(acquisition.file) !== name) continue;
    return { ...acquisition, updated: firstText(entry.body, "updated") };
  }
  return null;
}

/** The size, hashes and mirror URLs of a Metalink 4 (.meta4) file. The strongest hash comes first. */
export function parseMeta4(xml) {
  const file = xmlElements(xml, "file")[0]?.body ?? String(xml);
  const hashes = [];
  for (const hash of xmlElements(file, "hash")) {
    const algorithm = ALGORITHMS[String(hash.attributes.type || "").toLowerCase()];
    const hex = hash.body.trim().toLowerCase();
    if (algorithm && /^[0-9a-f]+$/.test(hex) && ALGORITHM_BY_LENGTH[hex.length] === algorithm) hashes.push({ algorithm, hex });
  }
  const order = { sha256: 0, sha1: 1, md5: 2 };
  hashes.sort((a, b) => order[a.algorithm] - order[b.algorithm]);
  const urls = xmlElements(file, "url")
    .map((url) => ({ href: url.body.trim(), priority: Number(url.attributes.priority) || 999 }))
    .filter((url) => /^https?:\/\//.test(url.href))
    .sort((a, b) => a.priority - b.priority)
    .map((url) => url.href);
  const size = Number(firstText(file, "size"));
  return { size: size > 0 ? size : null, hashes, urls };
}

/**
 * The hash in a checksum file ("<hex>  <file>", or "MD5 (<file>) = <hex>"). The line naming `fileName` wins.
 * `algorithm` overrides what the length of the hash says.
 */
export function parseChecksumFile(text, fileName, algorithm = null) {
  const lines = String(text).split("\n");
  const preferred = fileName ? lines.filter((line) => line.includes(fileName)) : [];
  for (const line of [...preferred, ...lines]) {
    for (const token of line.match(/[0-9a-fA-F]{32,64}/g) || []) {
      const byLength = ALGORITHM_BY_LENGTH[token.length];
      if (byLength) return { algorithm: algorithm || byLength, hex: token.toLowerCase() };
    }
  }
  return null;
}

function algorithmOfUrl(url) {
  const extension = String(url).toLowerCase().match(/\.(md5|sha1|sha256|sha-1|sha-256)(?:sum)?$/)?.[1];
  return extension ? ALGORITHMS[extension] : null;
}

export function formatBytes(bytes) {
  if (bytes == null) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatAge(days) {
  if (days == null) return "unknown age";
  if (days < 1) return "today";
  if (days < 2) return "1 day old";
  if (days < 60) return `${Math.floor(days)} days old`;
  if (days < 365 * 2) return `${Math.floor(days / 30)} months old`;
  return `${Math.floor(days / 365)} years old`;
}

const day = (value) => (value ? String(value).slice(0, 10) : null);

async function hashFile(file, algorithm, hash = crypto.createHash(algorithm)) {
  await pipeline(fs.createReadStream(file), new Writable({ write(chunk, _, done) { hash.update(chunk); done(); } }));
  return hash;
}

/**
 * @param {object} config  normalized configuration (see config.js)
 * @param {object} [options]  `fetchImpl` and `now` can be replaced in tests
 */
export function createLibrary(config, { log = () => {}, fetchImpl = fetch, now = () => new Date(), retryDelayMs = RETRY_DELAY_MS } = {}) {
  const settings = config.library;
  const regions = config.sources.maps?.regions || {};
  const keyOf = (item) => `${item.kind}:${item.id}`;

  function loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(settings.stateFile, "utf8"));
      return data && typeof data.items === "object" && data.items ? data : { version: 1, items: {} };
    } catch {
      return { version: 1, items: {} };
    }
  }

  function saveState(state) {
    fs.mkdirSync(path.dirname(settings.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${settings.stateFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(temporary, settings.stateFile);
  }

  function select(names) {
    if (!names.length) return settings.downloads;
    return names.map((name) => {
      const item = settings.downloads.find((candidate) => candidate.id === name);
      if (!item) throw new UserInputError(`"${name}" is not in library.downloads. Known: ${settings.downloads.map((candidate) => candidate.id).join(", ") || "none"}.`);
      return item;
    });
  }

  /** All editions of a ZIM series on disk, newest first. */
  function editionsOf(name) {
    let files;
    try { files = fs.readdirSync(config.kiwix.zimDir); } catch { return []; }
    return files.filter((file) => file.endsWith(".zim") && zimSeries(file) === name).sort().reverse()
      .map((file) => path.join(config.kiwix.zimDir, file));
  }

  const localFileOf = (item) => (item.kind === "zim" ? editionsOf(item.name)[0] || null : item.file);

  function fileFacts(file, entry) {
    const facts = { file: file ? path.basename(file) : null, exists: false, bytes: null, modifiedAt: null };
    if (!file) return facts;
    try {
      const stat = fs.statSync(file);
      Object.assign(facts, { exists: true, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    } catch { return facts; }
    const known = entry && entry.file === facts.file ? entry : null;
    return { ...facts, downloadedAt: known?.downloadedAt || null, verifiedAt: known?.verifiedAt || null, checksum: known?.checksum || null, remoteModified: known?.remoteModified || null };
  }

  function describe(item, state, managed = true) {
    const facts = fileFacts(localFileOf(item), state.items[keyOf(item)]);
    const edition = item.kind === "zim" ? zimEdition(facts.file || "") : day(facts.remoteModified || facts.modifiedAt);
    const since = item.kind === "zim" ? (edition ? Date.parse(`${edition.length === 7 ? `${edition}-01` : edition}T00:00:00Z`) : NaN) : Date.parse(facts.remoteModified || facts.modifiedAt || "");
    const ageDays = facts.exists && Number.isFinite(since) ? Math.max(0, (now().getTime() - since) / DAY_MS) : null;
    return { id: item.id, kind: item.kind, managed, ...facts, edition, ageDays };
  }

  /** What is in the library now, without touching the network. Files that are not in the download list are listed too. */
  function status() {
    const state = loadState();
    const rows = settings.downloads.map((item) => describe(item, state));
    const zimNames = new Set(settings.downloads.filter((item) => item.kind === "zim").map((item) => item.name));
    for (const book of config.kiwix.zimDir ? discoverBooks(config.kiwix.zimDir) : []) {
      if (!zimNames.has(book.series)) rows.push(describe({ id: book.series, kind: "zim", name: book.series }, state, false));
    }
    const mapIds = new Set(settings.downloads.filter((item) => item.kind === "map").map((item) => item.region));
    for (const [region, file] of Object.entries(regions)) {
      if (!mapIds.has(region)) rows.push(describe({ id: region, kind: "map", region, file }, state, false));
    }
    return rows;
  }

  async function fetchSmall(url, accept) {
    const response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT, ...(accept ? { accept } : {}) }, redirect: "follow", signal: AbortSignal.timeout(SMALL_TIMEOUT_MS) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`${url} answered ${response.status}`); }
    if (Number(response.headers.get("content-length")) > MAX_SMALL_RESPONSE) throw new Error(`${url} is unexpectedly large`);
    const text = await response.text();
    if (text.length > MAX_SMALL_RESPONSE) throw new Error(`${url} is unexpectedly large`);
    return text;
  }

  async function fetchChecksum(url, fileName) {
    const expected = parseChecksumFile(await fetchSmall(url), fileName, algorithmOfUrl(url));
    if (!expected) throw new Error(`${url} does not contain a checksum`);
    return expected;
  }

  /**
   * Where the latest edition of a ZIM book is, according to the Kiwix catalogue.
   * The catalogue is asked by the full name first, then by the name without its last part (the flavour),
   * since "wikipedia_nl_all_nopic" is listed under the name "wikipedia_nl_all".
   */
  async function remoteZim(item) {
    const shorter = item.name.replace(/_[^_]+$/, "");
    for (const candidate of shorter === item.name ? [item.name] : [item.name, shorter]) {
      const url = `${settings.kiwixCatalog}/entries?name=${encodeURIComponent(candidate)}&count=50`;
      const remote = parseCatalog(await fetchSmall(url, "application/atom+xml, application/xml, text/xml"), item.name, url);
      if (remote) return remote;
    }
    throw new Error(`"${item.name}" is not in the Kiwix catalogue (${settings.kiwixCatalog})`);
  }

  async function remoteMap(item) {
    const headers = { "user-agent": USER_AGENT };
    let response = await fetchImpl(item.url, { method: "HEAD", headers, redirect: "follow", signal: AbortSignal.timeout(SMALL_TIMEOUT_MS) });
    if ([405, 501].includes(response.status)) {
      response = await fetchImpl(item.url, { headers: { ...headers, range: "bytes=0-0" }, redirect: "follow", signal: AbortSignal.timeout(SMALL_TIMEOUT_MS) });
    }
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`${item.url} answered ${response.status}`);
    const modified = Date.parse(response.headers.get("last-modified") || "");
    const range = response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1];
    const length = Number(range || response.headers.get("content-length"));
    return { file: path.basename(item.file), url: item.url, bytes: length > 0 ? length : null, modifiedAt: Number.isFinite(modified) ? new Date(modified).toISOString() : null };
  }

  /** Compare one item with what the server offers. Returns { ...status row, remote, verdict }. */
  async function checkItem(item, state) {
    const row = describe(item, state);
    const remote = item.kind === "zim" ? await remoteZim(item) : await remoteMap(item);
    let verdict;
    if (!row.exists) verdict = "missing";
    else if (item.kind === "zim") verdict = remote.file.slice(0, -4) > row.file.slice(0, -4) ? "newer" : "current";
    else if (row.checksum && item.checksum) {
      const expected = await fetchChecksum(item.checksum, remote.file);
      verdict = `${expected.algorithm}:${expected.hex}` === row.checksum ? "current" : "newer";
    } else if (remote.modifiedAt && (row.remoteModified || row.modifiedAt)) {
      verdict = Date.parse(remote.modifiedAt) > Date.parse(row.remoteModified || row.modifiedAt) ? "newer" : "current";
    } else verdict = "unknown";
    return { ...row, remote, verdict };
  }

  /** Ask the servers whether newer editions exist. Nothing is downloaded. */
  async function check(names = []) {
    const state = loadState();
    const rows = [];
    for (const item of select(names)) {
      try {
        rows.push(await checkItem(item, state));
      } catch (error) {
        log(`${item.id}: ${error.message}`);
        rows.push({ ...describe(item, state), verdict: "error", error: error.message });
      }
    }
    return rows;
  }

  /**
   * Download one URL (trying the next one when a download fails) to `target`, resuming a `.part` file when there is one.
   * The hash is computed while downloading; the file is only put in place when it matches `expected`.
   */
  async function downloadFile({ id, urls, target, expected, bytes, modeLike = target }) {
    const part = `${target}.part`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // The new file gets the permissions of the file it replaces or follows; a first download is private to the owner.
    let mode = 0o600;
    try { mode = fs.statSync(modeLike).mode & 0o777; } catch {}
    let lastError = null;
    let mismatches = 0;
    for (const url of urls) {
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        try {
          const result = await transfer(id, url, part, expected, bytes);
          if (expected && result.digest !== expected.hex) {
            fs.rmSync(part, { force: true });
            mismatches += 1;
            throw new ChecksumError(`the ${expected.algorithm} checksum of the download does not match; the file was discarded`);
          }
          fs.chmodSync(part, mode);
          fs.renameSync(part, target);
          return result;
        } catch (error) {
          lastError = error;
          if (error instanceof ChecksumError && mismatches >= 2) throw error;
          const more = attempt < ATTEMPTS ? "trying again" : "trying the next address";
          log(`${id}: ${error.message}; ${more}`);
          await sleep(retryDelayMs * attempt);
        }
      }
    }
    throw lastError || new Error("no download address");
  }

  async function transfer(id, url, part, expected, totalBytes) {
    let hash = expected ? crypto.createHash(expected.algorithm) : null;
    let offset = 0;
    if (fs.existsSync(part)) {
      offset = fs.statSync(part).size;
      if (totalBytes && offset > totalBytes) { fs.rmSync(part, { force: true }); offset = 0; }
      else if (hash && offset) await hashFile(part, expected.algorithm, hash);
      if (offset) log(`${id}: continuing an earlier download at ${formatBytes(offset)}`);
    }
    if (totalBytes && offset === totalBytes) return { bytes: offset, digest: hash?.digest("hex") ?? null };

    const controller = new AbortController();
    const headers = { "user-agent": USER_AGENT, ...(offset ? { range: `bytes=${offset}-` } : {}) };
    const response = await fetchImpl(url, { headers, redirect: "follow", signal: controller.signal });
    if (offset && response.status === 416) {
      await response.body?.cancel().catch(() => {});
      fs.rmSync(part, { force: true });
      return transfer(id, url, part, expected, totalBytes);
    }
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${url} answered ${response.status}`);
    }
    let append = response.status === 206;
    if (!append && offset) { offset = 0; hash = expected ? crypto.createHash(expected.algorithm) : null; }
    const length = Number(response.headers.get("content-length"));
    const total = totalBytes || (length > 0 ? length + offset : null);
    let received = offset;
    let nextReport = received + (total ? Math.ceil(total / 10) : 512 * 1024 * 1024);
    let timer = null;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`no data received for ${STALL_MS / 1000} seconds`)), STALL_MS);
    };
    const counter = new Transform({
      transform(chunk, _, done) {
        touch();
        hash?.update(chunk);
        received += chunk.length;
        if (received >= nextReport) {
          log(`${id}: ${formatBytes(received)}${total ? ` of ${formatBytes(total)} (${Math.floor(received / total * 100)}%)` : ""}`);
          nextReport = received + (total ? Math.ceil(total / 10) : 512 * 1024 * 1024);
        }
        done(null, chunk);
      },
    });
    touch();
    try {
      await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(part, { flags: append ? "a" : "w" }));
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(timer);
    }
    if (total && received !== total) throw new Error(`the download stopped at ${formatBytes(received)} of ${formatBytes(total)}`);
    return { bytes: received, digest: hash?.digest("hex") ?? null };
  }

  async function downloadZim(item, remote, state) {
    let expected = null;
    let mirrors = [];
    if (item.checksum) {
      const meta = await fetchSmall(remote.meta4Url).then(parseMeta4).catch((error) => { log(`${item.id}: ${error.message}`); return null; });
      expected = meta?.hashes[0] || null;
      mirrors = meta?.urls || [];
      if (meta?.size) remote.bytes = meta.size;
      if (!expected) expected = await fetchChecksum(`${remote.url}.sha256`, remote.file).catch(() => null);
      if (!expected) throw new Error(`no checksum is published for ${remote.file}; set "checksum": false for this item to download it without one`);
    }
    const target = path.join(config.kiwix.zimDir, remote.file);
    log(`${item.id}: downloading ${remote.file}${remote.bytes ? ` (${formatBytes(remote.bytes)})` : ""}`);
    const result = await downloadFile({ id: item.id, urls: [remote.url, ...mirrors.filter((url) => url !== remote.url)], target, expected, bytes: remote.bytes, modeLike: editionsOf(item.name)[0] || target });
    const removed = [];
    if (!settings.keepOldEditions) {
      for (const file of editionsOf(item.name)) {
        if (file === target) continue;
        fs.rmSync(file, { force: true });
        removed.push(path.basename(file));
        log(`${item.id}: removed the older edition ${path.basename(file)}`);
      }
    }
    const stamp = now().toISOString();
    state.items[keyOf(item)] = { file: remote.file, bytes: result.bytes, checksum: expected ? `${expected.algorithm}:${expected.hex}` : null, url: remote.url, downloadedAt: stamp, verifiedAt: expected ? stamp : null };
    return { file: remote.file, bytes: result.bytes, removed };
  }

  async function downloadMap(item, remote, state) {
    const expected = item.checksum ? await fetchChecksum(item.checksum, remote.file) : null;
    log(`${item.id}: downloading ${remote.file}${remote.bytes ? ` (${formatBytes(remote.bytes)})` : ""}`);
    const result = await downloadFile({ id: item.id, urls: [item.url], target: item.file, expected, bytes: remote.bytes });
    const stamp = now().toISOString();
    state.items[keyOf(item)] = { file: remote.file, bytes: result.bytes, checksum: expected ? `${expected.algorithm}:${expected.hex}` : null, url: item.url, downloadedAt: stamp, verifiedAt: expected ? stamp : null, remoteModified: remote.modifiedAt };
    return { file: remote.file, bytes: result.bytes, removed: [] };
  }

  /**
   * Download what is missing or has a newer edition (everything with `force`).
   * @returns {{ items: object[], downloaded: number, failed: number }}
   */
  async function update(names = [], { force = false } = {}) {
    const state = loadState();
    const items = [];
    for (const item of select(names)) {
      let checked;
      try {
        checked = await checkItem(item, state);
      } catch (error) {
        log(`${item.id}: ${error.message}`);
        items.push({ id: item.id, kind: item.kind, action: "failed", error: error.message });
        continue;
      }
      if (!force && checked.verdict === "current") { items.push({ id: item.id, kind: item.kind, action: "current", file: checked.file }); continue; }
      if (!force && checked.verdict === "unknown") { items.push({ id: item.id, kind: item.kind, action: "unknown", file: checked.file }); continue; }
      try {
        const outcome = item.kind === "zim" ? await downloadZim(item, checked.remote, state) : await downloadMap(item, checked.remote, state);
        saveState(state);
        items.push({ id: item.id, kind: item.kind, action: "downloaded", ...outcome });
      } catch (error) {
        log(`${item.id}: ${error.message}`);
        items.push({ id: item.id, kind: item.kind, action: "failed", error: error.message });
      }
    }
    return { items, downloaded: items.filter((row) => row.action === "downloaded").length, failed: items.filter((row) => row.action === "failed").length };
  }

  /** Recompute the checksum of each file and compare it with the one recorded at download time. */
  async function verify(names = []) {
    const state = loadState();
    const rows = [];
    for (const item of select(names)) {
      const file = localFileOf(item);
      const entry = state.items[keyOf(item)];
      const row = { id: item.id, kind: item.kind, file: file ? path.basename(file) : null };
      if (!file || !fs.existsSync(file)) { rows.push({ ...row, status: "missing" }); continue; }
      if (!entry?.checksum || entry.file !== row.file) { rows.push({ ...row, status: "unknown" }); continue; }
      const [algorithm, hex] = entry.checksum.split(":");
      const digest = (await hashFile(file, algorithm)).digest("hex");
      if (digest === hex) {
        entry.verifiedAt = now().toISOString();
        saveState(state);
        rows.push({ ...row, status: "ok" });
      } else {
        rows.push({ ...row, status: "mismatch" });
      }
    }
    return rows;
  }

  return { status, check, update, verify };
}

const pad = (value, width) => String(value).padEnd(width);

/** One line per item, for the status and check commands. */
export function formatLibraryRows(rows) {
  if (!rows.length) return "The library is empty: no ZIM files, map regions or library.downloads are configured.";
  const width = Math.max(...rows.map((row) => row.id.length)) + 2;
  return rows.map((row) => {
    const parts = [pad(row.id, width), pad(row.kind, 5)];
    if (!row.exists) parts.push("not downloaded");
    else {
      parts.push(row.file, formatBytes(row.bytes));
      parts.push(row.kind === "zim" ? `edition ${row.edition || "?"}` : `dated ${row.edition || "?"}`);
      parts.push(formatAge(row.ageDays));
      if (row.downloadedAt) parts.push(`downloaded ${day(row.downloadedAt)}`);
      parts.push(row.verifiedAt ? `checksum verified ${day(row.verifiedAt)}` : "checksum unknown");
    }
    if (row.managed === false) parts.push("not in library.downloads");
    if (row.verdict === "newer") parts.push(`NEWER: ${row.remote.file}${row.remote.bytes ? ` (${formatBytes(row.remote.bytes)})` : ""}${row.kind === "map" && row.remote.modifiedAt ? ` dated ${day(row.remote.modifiedAt)}` : ""}`);
    else if (row.verdict === "missing") parts.push(`AVAILABLE: ${row.remote.file}${row.remote.bytes ? ` (${formatBytes(row.remote.bytes)})` : ""}`);
    else if (row.verdict === "current") parts.push("up to date");
    else if (row.verdict === "unknown") parts.push("cannot tell whether a newer version exists; use --force");
    else if (row.verdict === "error") parts.push(`ERROR: ${row.error}`);
    return parts.join("  ");
  }).join("\n");
}

export function formatUpdate(summary) {
  if (!summary.items.length) return "Nothing to update: library.downloads is empty.";
  const width = Math.max(...summary.items.map((row) => row.id.length)) + 2;
  const lines = summary.items.map((row) => {
    if (row.action === "downloaded") return `${pad(row.id, width)}downloaded ${row.file} (${formatBytes(row.bytes)})${row.removed?.length ? `; removed ${row.removed.join(", ")}` : ""}`;
    if (row.action === "current") return `${pad(row.id, width)}up to date (${row.file})`;
    if (row.action === "unknown") return `${pad(row.id, width)}cannot tell whether a newer version exists; use --force`;
    return `${pad(row.id, width)}FAILED: ${row.error}`;
  });
  lines.push("", `${summary.downloaded} downloaded, ${summary.failed} failed.`);
  return lines.join("\n");
}

export function formatVerify(rows) {
  if (!rows.length) return "Nothing to verify: library.downloads is empty.";
  const width = Math.max(...rows.map((row) => row.id.length)) + 2;
  const text = {
    ok: (row) => `ok        ${row.file}`,
    mismatch: (row) => `MISMATCH  ${row.file} differs from what was downloaded; run: arviro library update --force ${row.id}`,
    missing: () => "missing   no file; run: arviro library update",
    unknown: (row) => `unknown   ${row.file} was not downloaded by arviro, so there is no checksum to compare with`,
  };
  return rows.map((row) => `${pad(row.id, width)}${text[row.status](row)}`).join("\n");
}
