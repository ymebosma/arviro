// The search index: one SQLite file with full-text tables and embeddings.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const INDEX_VERSION = 2;
// Part of every document signature; change it to force re-embedding of all documents.
export const EMBEDDING_PROFILE = "multilingual-v1";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sources(
    id INTEGER PRIMARY KEY,
    corpus TEXT NOT NULL,
    path TEXT NOT NULL,
    content_path TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    signature TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    UNIQUE(corpus, path)
  );
  CREATE TABLE IF NOT EXISTS chunks(
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    page INTEGER,
    line_start INTEGER,
    line_end INTEGER,
    content TEXT NOT NULL,
    embedding BLOB NOT NULL,
    UNIQUE(source_id, ordinal)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content, title, source_path,
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TABLE IF NOT EXISTS osm_sources(
    region TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    signature TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS osm_objects(
    id INTEGER PRIMARY KEY,
    region TEXT NOT NULL,
    osm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    aliases TEXT NOT NULL,
    categories TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    place TEXT,
    tags TEXT NOT NULL,
    UNIQUE(region, osm_id)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS osm_fts USING fts5(
    name, aliases, categories,
    tokenize='unicode61 remove_diacritics 2'
  );
`;

/** Open the index for building: creates the file and tables when missing. */
export function openIndexForWrite(indexPath) {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(indexPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;");
  db.exec(SCHEMA);
  return db;
}

/** Open an existing index for searching. Returns null when there is no index yet. */
export function openIndexForRead(indexPath) {
  if (!fs.existsSync(indexPath)) return null;
  // Not opened read-only: a WAL database needs its -shm file, which a read-only connection cannot create.
  const db = new DatabaseSync(indexPath);
  db.exec("PRAGMA busy_timeout=10000; PRAGMA query_only=ON;");
  return db;
}

export function readMeta(db) {
  try {
    return Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((row) => [row.key, row.value]));
  } catch {
    return {};
  }
}

export function setMeta(db, key, value) {
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)").run(key, String(value));
}
