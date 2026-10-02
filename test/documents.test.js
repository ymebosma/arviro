import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { createArviro, expandQuery, inferPrefix } from "../src/arviro.js";
import { normalizeConfig } from "../src/config.js";
import { createEmbedder } from "../src/embeddings.js";
import { buildIndex, listDocuments } from "../src/indexer.js";
import { UserInputError } from "../src/text.js";
import { conceptEmbedder, fixtureConfig, makeFixture } from "./helpers.js";

const fixture = makeFixture();
const config = fixtureConfig(fixture);
const embedder = createEmbedder(config.embedding);
let arviro;
let firstBuild;

before(async () => {
  firstBuild = await buildIndex(config, embedder);
  arviro = createArviro(config);
});
after(() => {
  arviro.close();
  fixture.cleanup();
});

/** A separate fixture with its own index, for tests that change files or settings. */
async function withFixture(prepare, work) {
  const own = makeFixture();
  let ownArviro = null;
  try {
    const { config: ownConfig, embedder: ownEmbedder = createEmbedder(ownConfig.embedding) } = await prepare(own);
    const summary = await buildIndex(ownConfig, ownEmbedder);
    ownArviro = createArviro(ownConfig, { embedder: ownEmbedder });
    await work({ fixture: own, config: ownConfig, embedder: ownEmbedder, arviro: ownArviro, summary });
  } finally {
    ownArviro?.close();
    own.cleanup();
  }
}

test("listDocuments skips hidden, excluded and duplicate files", () => {
  const { items, incomplete } = listDocuments(config);
  assert.deepEqual(items.map((item) => `${item.corpus}/${item.relative}`), [
    "library/guides/documents/emergency-guide.pdf",
    "library/manuals/checklist.pdf",
    "library/manuals/first-aid.md",
    "library/manuals/water.txt",
    "library/web/standalone.html",
    "library/web/twin.txt",
    "wiki/family/grandmother.md",
  ]);
  assert.equal(incomplete.size, 0);
});

test("the first build indexes everything, a second build nothing", async () => {
  assert.equal(firstBuild.documents.indexed, 7);
  assert.equal(firstBuild.maps[0].objects, 6);
  const second = await buildIndex(config, embedder);
  assert.equal(second.documents.indexed, 0);
  assert.equal(second.documents.unchanged, 7);
  assert.equal(second.maps[0].unchanged, true);
});

test("search finds a passage and returns ready-made read arguments", async () => {
  const found = await arviro.search({ source: "library", query: "How long should I cool a burn?" });
  assert.equal(found.source, "library");
  assert.equal(found.results[0].title, "First aid at home");
  assert.deepEqual(found.results[0].read, { source: "library", path: "manuals/first-aid.md", offset: 1 });
  assert.match(found.resultPolicy, /read_document/);
  assert.equal(found.evidence, undefined);
});

test("a PDF with a text copy is cited as the PDF, with its page", async () => {
  const found = await arviro.search({ source: "library", query: "evacuation routes meeting point" });
  const [hit] = found.results;
  assert.equal(hit.kind, "pdf");
  assert.equal(hit.page, 2);
  assert.deepEqual(hit.read, { source: "library", path: "guides/documents/emergency-guide.pdf", offset: 2 });
});

test("a PDF without a text copy is converted with pdftotext, without layout padding", async () => {
  const found = await arviro.search({ source: "library", query: "spare batteries", pathPrefix: "manuals" });
  const hit = found.results.find((item) => item.read.path === "manuals/checklist.pdf");
  assert.equal(hit.kind, "pdf");
  assert.match(hit.excerpt, /^Checklist page \d: torch, radio and spare batteries\n {2}item {2}one$/);
});

test("pathPrefix filters by folder, including the folder of the text copy", async () => {
  const inDocuments = await arviro.search({ source: "library", query: "battery radio torch", pathPrefix: "guides/documents" });
  const inText = await arviro.search({ source: "library", query: "battery radio torch", pathPrefix: "guides/text" });
  const elsewhere = await arviro.search({ source: "library", query: "battery radio torch", pathPrefix: "web" });
  assert.equal(inDocuments.results.length, 1);
  assert.equal(inText.results.length, 1);
  assert.equal(inText.appliedPathPrefix, "guides/text");
  assert.equal(elsewhere.results.length, 0);
  assert.match(elsewhere.resultPolicy, /Nothing relevant/);
  await assert.rejects(arviro.search({ source: "library", query: "radio", pathPrefix: "../wiki" }), UserInputError);
});

test("pathPrefix matches whole folder names, in any letter case, or one exact file", async () => {
  const partial = await arviro.search({ source: "library", query: "battery radio torch", pathPrefix: "gui" });
  const upper = await arviro.search({ source: "library", query: "battery radio torch", pathPrefix: "GUIDES" });
  const file = await arviro.search({ source: "library", query: "bandages", pathPrefix: "manuals/first-aid.md" });
  assert.equal(partial.results.length, 0);
  assert.equal(upper.results.length, 1);
  assert.deepEqual(file.results.map((hit) => hit.read.path), ["manuals/first-aid.md"]);
});

test("a route narrows the search, and is dropped when it finds nothing", async () => {
  assert.equal(inferPrefix(config.sources.library.routes, "Where are the BANDAGEs?"), "manuals");
  const routed = await arviro.search({ source: "library", query: "first aid kit contents" });
  assert.equal(routed.appliedPathPrefix, "manuals");
  // "medical" routes to manuals/, where nothing matches; the search then covers the whole source.
  const fallback = await arviro.search({ source: "library", query: "medical candles" });
  assert.equal(fallback.appliedPathPrefix, undefined);
  assert.ok(fallback.results.some((hit) => hit.read.path === "web/twin.txt"));
});

test("expandQuery adds the configured cross-language terms", () => {
  assert.equal(expandQuery("Wat doe ik bij een brandwond?", config.search.queryExpansions), "Wat doe ik bij een brandwond?\nburn burns");
  assert.equal(expandQuery("Hoe laat is het?", config.search.queryExpansions), "Hoe laat is het?");
});

test("a Dutch question finds an English document through query expansion", async () => {
  const found = await arviro.search({ source: "library", query: "Wat doe ik bij een brandwond?" });
  assert.equal(found.results[0].read.path, "manuals/first-aid.md");
});

test("private sources are only visible in the full scope", async () => {
  const found = await arviro.search({ source: "wiki", query: "family bakery diary" });
  assert.equal(found.results[0].title, "Grandmother Anna");
  await assert.rejects(arviro.search({ source: "wiki", query: "family bakery diary" }, "public"), /Unknown source "wiki"/);
  await assert.rejects(arviro.read({ source: "wiki", path: "family/grandmother.md" }, "public"), /Unknown source/);
  assert.deepEqual(arviro.sources("public").map((source) => source.id).sort(), ["library", "maps", "wikipedia", "wikivoyage"]);
});

test("an exactly matching title verifies a who-is question", async () => {
  const verified = await arviro.search({ source: "wiki", query: "Who is Grandmother Anna?" });
  assert.equal(verified.evidence.status, "verified");
  assert.deepEqual(verified.evidence.requiredSource, { source: "wiki", path: "family/grandmother.md" });
  const unknown = await arviro.search({ source: "wiki", query: "Who is Zzqxv Nobody?" });
  assert.equal(unknown.evidence.status, "not_found");
});

test("input limits", async () => {
  await assert.rejects(arviro.search({ source: "library", query: "x" }), UserInputError);
  await assert.rejects(arviro.search({ source: "library", query: "x".repeat(501) }), UserInputError);
  await assert.rejects(arviro.search({ source: "nope", query: "water" }), /Available sources: library, wiki/);
  const limited = await arviro.search({ source: "library", query: "water storm candles bandages radio", limit: 2 });
  assert.equal(limited.results.length, 2);
  const onlyStopwords = await arviro.search({ source: "library", query: "what is the" });
  assert.equal(onlyStopwords.results.length, 0);
});

test("status reports sources and index contents", () => {
  const status = arviro.status();
  assert.equal(status.index.buildStatus, "ready");
  assert.deepEqual(status.index.documents.map((row) => row.source), ["library", "wiki"]);
  assert.deepEqual(status.index.maps, [{ region: "test", objects: 6 }]);
  assert.equal(status.index.dimensions, 0);
});

test("changed and removed files are picked up by the next build", async () => {
  await withFixture((own) => ({ config: fixtureConfig(own) }), async ({ fixture: own, config: ownConfig, embedder: ownEmbedder, arviro: ownArviro }) => {
    fs.writeFileSync(path.join(own.library, "manuals/water.txt"), "Rainwater\n\nCollect rainwater in a clean barrel and filter it before use.\n");
    fs.rmSync(path.join(own.library, "web/standalone.html"));
    const summary = await buildIndex(ownConfig, ownEmbedder);
    assert.equal(summary.documents.indexed, 1);
    assert.equal(summary.documents.removed, 1);
    // The running application sees the new index without a restart.
    const rain = await ownArviro.search({ source: "library", query: "rainwater barrel" });
    assert.equal(rain.results[0].read.path, "manuals/water.txt");
    const storm = await ownArviro.search({ source: "library", query: "storm shutters" });
    assert.equal(storm.results.length, 0);
  });
});

test("a source folder that is missing during a build keeps its documents in the index", async () => {
  await withFixture((own) => ({ config: fixtureConfig(own) }), async ({ fixture: own, config: ownConfig, embedder: ownEmbedder, arviro: ownArviro }) => {
    fs.renameSync(own.wiki, `${own.wiki}-unmounted`);
    const logged = [];
    const summary = await buildIndex(ownConfig, ownEmbedder, { log: (message) => logged.push(message) });
    assert.deepEqual(summary.documents.incomplete, ["wiki"]);
    assert.equal(summary.documents.removed, 0);
    assert.ok(logged.some((message) => /nothing was removed from: wiki/.test(message)));
    const found = await ownArviro.search({ source: "wiki", query: "family bakery diary" });
    assert.equal(found.results.length, 1);
    await assert.rejects(ownArviro.read(found.results[0].read), /folder of this source is not available/);
  });
});

test("a file that cannot be converted is skipped without stopping the build", async () => {
  await withFixture((own) => ({ config: fixtureConfig(own, { tools: { pdftotext: path.join(own.root, "bin/pdftotext-broken"), osmium: false, kiwixServe: false } }) }), async ({ summary, fixture: own }) => {
    assert.equal(summary.documents.skipped, 1);
    assert.equal(summary.documents.indexed, 6);
    assert.ok(!JSON.stringify(summary).includes(own.root));
  });
});

test("form feeds and old Mac line endings in plain text do not confuse line numbers", async () => {
  await withFixture((own) => {
    fs.writeFileSync(path.join(own.library, "manuals/notes.txt"), `first paragraph about lanterns and oil\n\fsecond paragraph about wicks and matches\n`);
    fs.writeFileSync(path.join(own.library, "manuals/classic.txt"), Array.from({ length: 30 }, (_, index) => `classic line ${index + 1} about telegraph keys`).join("\r"));
    return { config: fixtureConfig(own) };
  }, async ({ arviro: ownArviro }) => {
    const notes = await ownArviro.search({ source: "library", query: "wicks matches", pathPrefix: "manuals/notes.txt" });
    assert.equal(notes.results[0].kind, "txt");
    assert.equal(notes.results[0].page, undefined);
    assert.deepEqual(notes.results[0].read, { source: "library", path: "manuals/notes.txt", offset: 1 });
    const classic = await ownArviro.search({ source: "library", query: "telegraph keys", pathPrefix: "manuals/classic.txt" });
    assert.equal(classic.results[0].lines, "1-30");
    const read = await ownArviro.read({ source: "library", path: "manuals/classic.txt", offset: 29 });
    assert.deepEqual(read.text.split("\n").slice(2), ["lines: 29-30 of 30", "29: classic line 29 about telegraph keys", "30: classic line 30 about telegraph keys"]);
  });
});

test("a private source inside a public one is not searched or read through the public one", async () => {
  await withFixture((own) => {
    const diary = path.join(own.library, "diary");
    fs.mkdirSync(diary);
    fs.writeFileSync(path.join(diary, "january.md"), "# January\n\nA secret entry about the hidden treasure map in the attic.\n");
    return { config: normalizeConfig({
      dataDir: path.join(own.root, "data"),
      sources: { library: { path: own.library }, diary: { path: diary, private: true } },
      embedding: { provider: "none" },
      tools: { pdftotext: false, osmium: false, kiwixServe: false },
    }) };
  }, async ({ arviro: ownArviro }) => {
    const viaLibrary = await ownArviro.search({ source: "library", query: "treasure map attic" }, "public");
    assert.equal(viaLibrary.results.length, 0);
    await assert.rejects(ownArviro.read({ source: "library", path: "diary/january.md" }, "public"), /not part of this source/);
    const viaDiary = await ownArviro.search({ source: "diary", query: "treasure map attic" });
    assert.equal(viaDiary.results[0].read.path, "january.md");
    assert.match((await ownArviro.read(viaDiary.results[0].read)).text, /hidden treasure map/);
  });
});

test("with embeddings, a passage can match by meaning alone", async () => {
  const concepts = conceptEmbedder([["kitten", "feline"], ["bandage", "dressing"], ["unused"]]);
  await withFixture((own) => {
    fs.writeFileSync(path.join(own.library, "manuals/pets.md"), "# Pets\n\nA kitten needs warmth, milk and a quiet place to sleep at night.\n");
    return { config: fixtureConfig(own, { embedding: { provider: "ollama", model: "test-concepts", dimensions: 5 } }), embedder: concepts };
  }, async ({ arviro: ownArviro, config: ownConfig, summary }) => {
    assert.equal(summary.documents.notEmbedded, 0);
    const found = await ownArviro.search({ source: "library", query: "feline care" });
    assert.equal(found.results[0].read.path, "manuals/pets.md");
    assert.equal(found.warnings, undefined);
    // Without a literal or semantic match nothing is returned, rather than weak guesses.
    const none = await ownArviro.search({ source: "library", query: "quantum chromodynamics" });
    assert.equal(none.results.length, 0);
    // Another embedding size in the configuration rebuilds the index on the next run.
    const resized = { ...ownConfig, embedding: { ...ownConfig.embedding, dimensions: 6 } };
    const logged = [];
    const rebuilt = await buildIndex(resized, concepts, { log: (message) => logged.push(message) });
    assert.equal(rebuilt.documents.indexed, 8);
    assert.ok(logged.some((message) => /embedding size changed \(5 -> 6\)/.test(message)));
  });
});

test("a passage that cannot be embedded is still found by its words", async () => {
  const picky = {
    enabled: true,
    model: "test-picky",
    async embed(inputs) { return inputs.map((input) => (input.includes("Drinking water") ? null : [1, 0])); },
  };
  await withFixture((own) => ({ config: fixtureConfig(own, { embedding: { provider: "ollama", model: "test-picky", dimensions: 2 } }), embedder: picky }), async ({ arviro: ownArviro, summary }) => {
    assert.equal(summary.documents.notEmbedded, 1);
    const found = await ownArviro.search({ source: "library", query: "boil drinking water", pathPrefix: "manuals/water.txt" });
    assert.equal(found.results.length, 1);
  });
});

test("when the embedding service fails, search falls back to literal matches with a warning", async () => {
  const failing = { enabled: true, model: "none", async embed() { throw new Error("connect ECONNREFUSED /private/path"); } };
  const fallbackArviro = createArviro(config, { embedder: failing });
  try {
    const found = await fallbackArviro.search({ source: "library", query: "bandages gloves" });
    assert.equal(found.results[0].read.path, "manuals/first-aid.md");
    assert.deepEqual(found.warnings, ["Search by meaning is unavailable right now; only literal word matches were used."]);
  } finally {
    fallbackArviro.close();
  }
});

test("an index built with another embedding model is searched by words only, with a warning", async () => {
  let asked = 0;
  const other = { enabled: true, model: "another-model", async embed(inputs) { asked += 1; return inputs.map(() => [1, 0]); } };
  const staleArviro = createArviro(config, { embedder: other });
  try {
    const found = await staleArviro.search({ source: "library", query: "bandages gloves" });
    assert.equal(found.results[0].read.path, "manuals/first-aid.md");
    assert.match(found.warnings[0], /built with other embedding settings/);
    assert.equal(asked, 0);
  } finally {
    staleArviro.close();
  }
});
