import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createArviro } from "../src/arviro.js";
import { articleLines, parseSearchXml } from "../src/kiwix.js";
import { UserInputError } from "../src/text.js";
import { conceptEmbedder, fixtureConfig, makeFixture, startFakeKiwix, WIKIPEDIA_BOOK, WIKIVOYAGE_BOOK } from "./helpers.js";

const fixture = makeFixture();
let fake;
let arviro;

before(async () => {
  fake = await startFakeKiwix();
  arviro = createArviro(fixtureConfig(fixture, { kiwix: { zimDir: fixture.zimDir, port: fake.port } }));
});
after(async () => {
  arviro.close();
  await fake.close();
  fixture.cleanup();
});

test("parseSearchXml reads title, link and snippet", () => {
  const xml = `<rss><channel><title>Search: x</title>
    <item><title>Tom &amp; Jerry</title><link>/kiwix/content/book/Tom_%26_Jerry</link>
      <description>...a <b>cat</b> &amp; a mouse...</description><book><title>Wikipedia</title></book></item>
    <item><title>No link</title></item><item><title>Unclosed</title><link>/x</link></channel></rss>`;
  assert.deepEqual(parseSearchXml(xml), [{ title: "Tom & Jerry", link: "/kiwix/content/book/Tom_%26_Jerry", snippet: "...a cat & a mouse..." }]);
  const started = Date.now();
  assert.deepEqual(parseSearchXml("<item>".repeat(200_000)), []);
  assert.ok(Date.now() - started < 1000);
});

test("articleLines turns block elements into lines", () => {
  assert.deepEqual(articleLines("<html><head><title>T</title></head><body><h1>Kop</h1><p>Een  alinea.</p><ul><li>punt</li></ul></body></html>"), ["Kop", "Een alinea.", "punt"]);
});

test("search covers only the books of the chosen source", async () => {
  const wikipedia = await arviro.search({ source: "wikipedia", query: "Waar ligt Gouda?" });
  assert.deepEqual(wikipedia.results.map((hit) => hit.read), [{ source: "wikipedia", path: `/kiwix/content/${WIKIPEDIA_BOOK}/Gouda` }]);
  const wikivoyage = await arviro.search({ source: "wikivoyage", query: "Waar ligt Gouda?" });
  assert.deepEqual(wikivoyage.results.map((hit) => hit.read.path), [`/kiwix/content/${WIKIVOYAGE_BOOK}/Gouda`]);
  assert.ok(fake.requests.every((request) => !request.includes("2025-01")), "the older edition is not queried");
});

test("who-is questions are verified, ambiguous or not found", async () => {
  const verified = await arviro.search({ source: "wikipedia", query: "Ken je Gregor Kobel?" });
  assert.equal(verified.evidence.status, "verified");
  assert.deepEqual(verified.evidence.requiredSource, { source: "wikipedia", path: `/kiwix/content/${WIKIPEDIA_BOOK}/Gregor_Kobel` });

  const typo = await arviro.search({ source: "wikipedia", query: "Wie is Gregor Kobelx?" });
  assert.equal(typo.evidence.status, "ambiguous");
  assert.deepEqual(typo.evidence.candidates.map((item) => item.title), ["Gregor Kobel"]);

  const unknown = await arviro.search({ source: "wikipedia", query: "Wie is Zzqxv Nietbestaand?" });
  assert.equal(unknown.evidence.status, "not_found");
  assert.equal(unknown.results.length, 0);

  // The advice that comes with the results follows the verdict.
  assert.match(verified.resultPolicy, /Answer only from that source/);
  assert.match(typo.resultPolicy, /ask the user which of evidence\.candidates/);
  assert.match(unknown.resultPolicy, /cannot confirm/);
});

test("an article is read as numbered lines", async () => {
  const result = await arviro.read({ source: "wikipedia", path: `/kiwix/content/${WIKIPEDIA_BOOK}/Gregor_Kobel` });
  assert.deepEqual(result.text.split("\n"), [
    "source: wikipedia",
    `path: /kiwix/content/${WIKIPEDIA_BOOK}/Gregor_Kobel`,
    "title: Gregor Kobel",
    "lines: 1-3 of 3",
    "1: Gregor Kobel",
    "2: Gregor Kobel is een Zwitsers voetballer die als doelman speelt.",
    "3: Tweede alinea.",
  ]);
});

test("an article whose title contains dots can be found and read", async () => {
  const found = await arviro.search({ source: "wikipedia", query: "Hollywood film" });
  const { read } = found.results[0];
  assert.equal(read.path, `/kiwix/content/${WIKIPEDIA_BOOK}/Once_Upon_a_Time..._in_Hollywood`);
  assert.match((await arviro.read(read)).text, /title: Once Upon a Time\.\.\. in Hollywood/);
});

test("only article links of the source's own books can be read", async () => {
  const attempts = [
    `/kiwix/content/${WIKIVOYAGE_BOOK}/Gouda`, // a book of another source
    `/kiwix/content/${WIKIPEDIA_BOOK}/../../etc/passwd`,
    `/kiwix/content/${WIKIPEDIA_BOOK}/%2e%2e/%2e%2e/secret`,
    `/kiwix/content/${WIKIPEDIA_BOOK}/..%2f..%2fsecret`,
    `/kiwix/content/${WIKIPEDIA_BOOK}/..\\..\\secret`,
    `/kiwix/content/${WIKIPEDIA_BOOK}/`,
    "/kiwix/search?pattern=x",
    "http://example.com/kiwix/content/x/y",
    `//example.com/kiwix/content/${WIKIPEDIA_BOOK}/Gouda`,
    "",
  ];
  for (const attempt of attempts) {
    await assert.rejects(arviro.read({ source: "wikipedia", path: attempt }), UserInputError, attempt);
  }
  await assert.rejects(arviro.read({ source: "wikipedia", path: `/kiwix/content/${WIKIPEDIA_BOOK}/Does_not_exist` }), /does not exist/);
});

test("a question with many names leads to a bounded number of searches", async () => {
  const before = fake.requests.length;
  const names = Array.from({ length: 60 }, (_, index) => `Naam${String.fromCharCode(65 + (index % 26))}${index}`).join(" ");
  await arviro.search({ source: "wikipedia", query: `Wat weet je over ${names}`.slice(0, 500) });
  const searches = fake.requests.slice(before).filter((request) => request.startsWith("/kiwix/search"));
  assert.ok(searches.length <= 8, `${searches.length} searches`);
});

test("results are re-ranked by meaning when embeddings are available", async () => {
  const embedder = conceptEmbedder([["doelman", "keeper"], ["gemeente"], ["unused"]]);
  const ranked = createArviro(fixtureConfig(fixture, { kiwix: { zimDir: fixture.zimDir, port: fake.port } }), { embedder });
  try {
    // "Kobel" and "Gouda" are both found by pattern; the question is about a keeper.
    const found = await ranked.search({ source: "wikipedia", query: "keeper Kobel Gouda" });
    assert.deepEqual(found.results.map((hit) => hit.title), ["Gregor Kobel", "Gouda"]);
    assert.equal(found.warnings, undefined);
  } finally {
    ranked.close();
  }
});

test("without kiwix-serve the source is reported as unavailable", async () => {
  const offline = createArviro(fixtureConfig(fixture));
  try {
    const found = await offline.search({ source: "wikipedia", query: "Ken je Gregor Kobel?" });
    assert.equal(found.results.length, 0);
    assert.equal(found.evidence.status, "unavailable");
    assert.deepEqual(found.warnings, ["wikipedia is not available: Kiwix books cannot be read: kiwix-serve is not installed."]);
    assert.match(found.resultPolicy, /could not be searched/);
    await assert.rejects(offline.read({ source: "wikipedia", path: `/kiwix/content/${WIKIPEDIA_BOOK}/Gouda` }), /kiwix-serve is not installed/);
  } finally {
    offline.close();
  }
});
