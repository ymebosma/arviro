import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigError, discoverBooks, expandHome, normalizeConfig, sourcesInScope } from "../src/config.js";
import { fixtureConfig, makeFixture, WIKIPEDIA_BOOK, WIKIVOYAGE_BOOK } from "./helpers.js";

const fixture = makeFixture();
after(() => fixture.cleanup());

test("expandHome", () => {
  assert.equal(expandHome("~/x"), path.join(os.homedir(), "x"));
  assert.equal(expandHome("/abs/x"), "/abs/x");
});

test("discoverBooks keeps the newest edition of each series", () => {
  const books = discoverBooks(fixture.zimDir);
  assert.deepEqual(books.map((book) => book.name).sort(), [WIKIPEDIA_BOOK, WIKIVOYAGE_BOOK]);
  assert.deepEqual(books.map((book) => book.sourceId).sort(), ["wikipedia", "wikivoyage"]);
  assert.deepEqual(discoverBooks(path.join(fixture.root, "missing")), []);
});

test("normalizeConfig derives sources for documents, ZIM books and maps", () => {
  const config = fixtureConfig(fixture);
  assert.deepEqual(Object.keys(config.sources).sort(), ["library", "maps", "wiki", "wikipedia", "wikivoyage"]);
  assert.equal(config.sources.library.type, "documents");
  assert.equal(config.sources.wikipedia.type, "kiwix");
  assert.equal(config.sources.maps.type, "maps");
  assert.equal(config.indexPath, path.join(fixture.root, "data", "index.sqlite"));
  assert.equal(config.embedding.model, "none");
});

test("sourcesInScope hides private sources from the public scope", () => {
  const config = fixtureConfig(fixture);
  assert.ok(sourcesInScope(config, "all").some((source) => source.id === "wiki"));
  assert.ok(!sourcesInScope(config, "public").some((source) => source.id === "wiki"));
});

test("relative paths are resolved against the config file", () => {
  const config = normalizeConfig({ dataDir: "data", sources: { docs: { path: "docs" } } }, { configPath: "/etc/arviro/config.json" });
  assert.equal(config.sources.docs.root, "/etc/arviro/docs");
  assert.equal(config.dataDir, "/etc/arviro/data");
});

test("a source folder inside another source is recorded, and two sources cannot share a folder", () => {
  const config = normalizeConfig({ sources: {
    library: { path: fixture.library },
    notes: { path: path.join(fixture.library, "manuals"), private: true },
    wiki: { path: fixture.wiki },
  } });
  assert.deepEqual(config.sources.library.nested, [path.join(fixture.library, "manuals")]);
  assert.deepEqual(config.sources.notes.nested, []);
  assert.deepEqual(config.sources.wiki.nested, []);
  assert.throws(() => normalizeConfig({ sources: { a: { path: fixture.wiki }, b: { path: `${fixture.wiki}/` } } }), /use the same folder/);
});

test("each endpoint has its own optional token", () => {
  const config = normalizeConfig({ server: { authToken: "full", publicToken: "public" } });
  assert.equal(config.server.authToken, "full");
  assert.equal(config.server.publicToken, "public");
  assert.equal(normalizeConfig({}).server.authToken, null);
});

test("the example configuration in the repository is valid", () => {
  const examplePath = fileURLToPath(new URL("../arviro.config.example.json", import.meta.url));
  const config = normalizeConfig(JSON.parse(fs.readFileSync(examplePath, "utf8")), { configPath: examplePath });
  for (const id of ["library", "notes", "maps"]) assert.ok(config.sources[id], id);
  assert.equal(config.sources.notes.private, true);
  assert.equal(config.server.host, "127.0.0.1");
});

test("invalid configurations are rejected with a clear message", () => {
  assert.throws(() => normalizeConfig({ sources: { "Bad Id": { path: "x" } } }), ConfigError);
  assert.throws(() => normalizeConfig({ sources: { maps: { path: "x" } } }), /reserved/);
  assert.throws(() => normalizeConfig({ sources: { docs: {} } }), /path is required/);
  assert.throws(() => normalizeConfig({ sources: { wikipedia: { path: "x" } }, kiwix: { zimDir: fixture.zimDir } }), /both a document source and a ZIM file/);
  assert.throws(() => normalizeConfig({ embedding: { provider: "magic" } }), ConfigError);
  assert.throws(() => normalizeConfig({ embedding: { dimensions: 0.5 } }), /dimensions/);
  assert.throws(() => normalizeConfig({ search: { queryExpansions: [["(", "x"]] } }), /regular expression/);
});
