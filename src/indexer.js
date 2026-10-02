// Builds and updates the search index. Unchanged files are skipped, so a re-run is cheap.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pdfOfTextCopy, textCopyOf } from "./copies.js";
import { EMBEDDING_PROFILE, INDEX_VERSION, openIndexForWrite, readMeta, setMeta } from "./db.js";
import { PREFIX, vectorToBlob } from "./embeddings.js";
import { indexOsmRegion, removeStaleRegions } from "./osm.js";
import { pdfToText } from "./reader.js";
import { chunksFromLines, chunksFromPages, htmlToText, squeezeSpaces, titleFromText } from "./text.js";

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".html", ".csv", ".tsv", ".json"]);
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_CHUNKS_PER_DOCUMENT = 20_000;
const EMBED_BATCH = 128;
const CHUNKS_PER_TRANSACTION_GROUP = 1200;

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function realPathOrSelf(target) {
  try { return fs.realpathSync(target); } catch { return target; }
}

/**
 * All indexable files of the document sources.
 * `relative` is the path a document is cited by; `file` is the file its text comes from.
 * `incomplete` holds the ids of sources with a folder or file that could not be read; for those,
 * nothing is removed from the index, so an unmounted disk does not wipe a source.
 */
export function listDocuments(config, log = () => {}) {
  const items = [];
  const incomplete = new Set();
  const toPosix = (value) => value.split(path.sep).join("/");
  for (const source of Object.values(config.sources)) {
    if (source.type !== "documents") continue;
    const root = realPathOrSelf(source.root);
    const nested = new Set(source.nested.map(realPathOrSelf));
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (error) {
        log(`${source.id}: cannot read ${current === root ? "the source folder" : toPosix(path.relative(root, current))} (${error.code || error.message})`);
        incomplete.add(source.id);
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || source.exclude.has(entry.name) || entry.isSymbolicLink()) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!nested.has(full)) stack.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).toLowerCase();
        if (extension !== ".pdf" && !TEXT_EXTENSIONS.has(extension)) continue;
        let size;
        try {
          size = fs.statSync(full).size;
        } catch {
          incomplete.add(source.id);
          continue;
        }
        const item = { corpus: source.id, file: full, content: toPosix(path.relative(root, full)), extract: "text" };
        if (extension === ".pdf") {
          if (size > MAX_PDF_BYTES || !config.tools.pdftotext || textCopyOf(full)) continue;
          items.push({ ...item, relative: item.content, kind: "pdf", extract: "pdf" });
        } else {
          if (size > MAX_TEXT_BYTES) continue;
          if (extension === ".html" && fs.existsSync(`${full.slice(0, -5)}.txt`)) continue;
          const pdf = extension === ".txt" ? pdfOfTextCopy(full) : null;
          items.push(pdf
            ? { ...item, relative: toPosix(path.relative(root, pdf)), kind: "pdf" }
            : { ...item, relative: item.content, kind: extension.slice(1) });
        }
      }
    }
  }
  items.sort((a, b) => `${a.corpus}/${a.relative}`.localeCompare(`${b.corpus}/${b.relative}`, "nl"));
  return { items, incomplete };
}

async function documentText(item, config) {
  if (item.extract === "pdf") return squeezeSpaces(await pdfToText(config.tools.pdftotext, item.file));
  const text = fs.readFileSync(item.file, "utf8").replace(/\u0000/g, "");
  return squeezeSpaces(path.extname(item.file).toLowerCase() === ".html" ? htmlToText(text) : text);
}

/** Passages of a document. Only a document cited as a PDF has pages; elsewhere a form feed is just a character. */
function chunksOf(item, text) {
  const chunks = item.kind === "pdf" ? chunksFromPages(text) : chunksFromLines(text.replace(/\f/g, " "));
  return chunks.slice(0, MAX_CHUNKS_PER_DOCUMENT);
}

function deleteSource(db, id) {
  db.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE source_id=?)").run(id);
  db.prepare("DELETE FROM sources WHERE id=?").run(id);
}

function inTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function indexDocuments(db, config, embedder, log) {
  const { items, incomplete } = listDocuments(config, log);
  const existing = new Map(db.prepare("SELECT id, corpus, path, content_path, kind, signature FROM sources").all().map((row) => [`${row.corpus}:${row.path}`, row]));
  const seen = new Set();
  const pending = [];
  let unchanged = 0;
  let skipped = 0;
  const relocate = db.prepare("UPDATE sources SET content_path=?, kind=? WHERE id=?");

  for (const item of items) {
    const key = `${item.corpus}:${item.relative}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const prior = existing.get(key);
    // A file that cannot be read or converted is skipped; an earlier indexed version stays in the index.
    try {
      const signature = `${EMBEDDING_PROFILE}:${sha256File(item.file)}`;
      if (prior?.signature === signature) {
        if (prior.content_path !== item.content || prior.kind !== item.kind) relocate.run(item.content, item.kind, prior.id);
        unchanged += 1;
        continue;
      }
      const text = await documentText(item, config);
      pending.push({ item, key, signature, title: titleFromText(item.relative, text), chunks: chunksOf(item, text) });
    } catch (error) {
      log(`skipped ${key}: ${String(error.cause?.stderr || error.message).trim().split("\n")[0]}`);
      skipped += 1;
    }
  }

  const insertSource = db.prepare("INSERT INTO sources(corpus,path,content_path,kind,title,signature,indexed_at) VALUES(?,?,?,?,?,?,?)");
  const insertChunk = db.prepare("INSERT INTO chunks(source_id,ordinal,page,line_start,line_end,content,embedding) VALUES(?,?,?,?,?,?,?)");
  const insertFts = db.prepare("INSERT INTO chunks_fts(rowid,content,title,source_path) VALUES(?,?,?,?)");
  let indexed = 0;
  let chunksAdded = 0;
  let notEmbedded = 0;
  let position = 0;
  while (position < pending.length) {
    const group = [];
    let groupChunks = 0;
    do {
      group.push(pending[position]);
      groupChunks += pending[position].chunks.length;
      position += 1;
    } while (position < pending.length && groupChunks < CHUNKS_PER_TRANSACTION_GROUP);

    const jobs = group.flatMap((document) => document.chunks.map((chunk) => ({ document, chunk, embedding: null })));
    if (embedder.enabled) {
      for (let offset = 0; offset < jobs.length; offset += EMBED_BATCH) {
        const batch = jobs.slice(offset, offset + EMBED_BATCH);
        const inputs = batch.map((job) => `${job.document.title}\n${job.chunk.content}`.slice(0, 4000));
        const vectors = await embedder.embed(inputs, PREFIX.document, { attempts: 5, timeoutMs: 180_000, tolerant: true });
        for (let index = 0; index < batch.length; index += 1) {
          batch[index].embedding = vectors[index];
          if (!vectors[index]) notEmbedded += 1;
        }
      }
    }

    let cursor = 0;
    for (const { item, key, signature, title, chunks } of group) {
      const embeddings = jobs.slice(cursor, cursor + chunks.length).map((job) => job.embedding);
      cursor += chunks.length;
      inTransaction(db, () => {
        const prior = existing.get(key);
        if (prior) deleteSource(db, prior.id);
        const source = insertSource.run(item.corpus, item.relative, item.content, item.kind, title, signature, new Date().toISOString());
        for (let ordinal = 0; ordinal < chunks.length; ordinal += 1) {
          const chunk = chunks[ordinal];
          const blob = embeddings[ordinal] ? vectorToBlob(embeddings[ordinal]) : Buffer.alloc(0);
          const inserted = insertChunk.run(source.lastInsertRowid, ordinal, chunk.page ?? null, chunk.lineStart ?? null, chunk.lineEnd ?? null, chunk.content, blob);
          insertFts.run(inserted.lastInsertRowid, chunk.content, title, `${item.corpus}/${item.relative}`);
        }
      });
      indexed += 1;
      chunksAdded += chunks.length;
    }
    log(`documents stored: ${indexed}/${pending.length}; passages ${chunksAdded}`);
  }
  if (notEmbedded) log(`${notEmbedded} passage(s) could not be embedded; they are found by their words only`);

  let removed = 0;
  for (const [key, row] of existing) {
    if (seen.has(key) || incomplete.has(row.corpus)) continue;
    inTransaction(db, () => deleteSource(db, row.id));
    removed += 1;
  }
  if (incomplete.size) log(`not fully readable, so nothing was removed from: ${[...incomplete].join(", ")}`);
  return { discovered: items.length, indexed, unchanged, removed, skipped, chunksAdded, notEmbedded, incomplete: [...incomplete] };
}

function storedDimensions(db, meta) {
  if (meta.dimensions !== undefined) return Number(meta.dimensions);
  const row = db.prepare("SELECT length(embedding) AS bytes FROM chunks WHERE length(embedding) > 0 LIMIT 1").get();
  return row ? Number(row.bytes) / 4 : null;
}

/**
 * Update the index for all configured document sources and map regions.
 * @param {object} options
 * @param {boolean} [options.full]  rebuild everything instead of only what changed
 * @returns summary with counts
 */
export async function buildIndex(config, embedder, { log = () => {}, full = false } = {}) {
  const db = openIndexForWrite(config.indexPath);
  try {
    const meta = readMeta(db);
    const dimensions = embedder.enabled ? config.embedding.dimensions : 0;
    const before = storedDimensions(db, meta);
    const reason = meta.version && Number(meta.version) !== INDEX_VERSION ? "the index format changed"
      : meta.model && meta.model !== embedder.model ? `the embedding model changed (${meta.model} -> ${embedder.model})`
        : before !== null && before !== dimensions ? `the embedding size changed (${before} -> ${dimensions})`
          : full ? "a full rebuild was requested" : null;
    if (reason) {
      log(`${reason}: rebuilding everything`);
      db.exec("DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM sources; DELETE FROM osm_fts; DELETE FROM osm_objects; DELETE FROM osm_sources;");
    }
    setMeta(db, "version", INDEX_VERSION);
    setMeta(db, "model", embedder.model);
    setMeta(db, "dimensions", dimensions);
    setMeta(db, "build_status", "running");

    const documents = await indexDocuments(db, config, embedder, log);
    const regions = config.sources.maps?.regions || {};
    const maps = [];
    for (const [region, file] of Object.entries(regions)) maps.push(await indexOsmRegion(db, region, file, config.tools.osmium, log));
    const removedRegions = removeStaleRegions(db, Object.keys(regions));

    setMeta(db, "updated_at", new Date().toISOString());
    setMeta(db, "build_status", "ready");
    db.exec("PRAGMA optimize;");
    const pageCount = Number(db.prepare("PRAGMA page_count").get().page_count);
    const freePages = Number(db.prepare("PRAGMA freelist_count").get().freelist_count);
    if (pageCount > 0 && freePages / pageCount > 0.2) db.exec("VACUUM;");
    return { documents, maps, removedRegions, model: embedder.model };
  } finally {
    db.close();
  }
}
