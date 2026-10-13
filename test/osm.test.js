import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createArviro } from "../src/arviro.js";
import { createEmbedder } from "../src/embeddings.js";
import { buildIndex } from "../src/indexer.js";
import { parseOplNode } from "../src/osm.js";
import { fixtureConfig, makeFixture } from "./helpers.js";

const fixture = makeFixture();
const config = fixtureConfig(fixture);
let arviro;

before(async () => {
  await buildIndex(config, createEmbedder(config.embedding));
  arviro = createArviro(config);
});
after(() => {
  arviro.close();
  fixture.cleanup();
});

test("parseOplNode decodes names, tags and coordinates", () => {
  const node = parseOplNode("n42 v1 dV c0 t i0 u Tamenity=hospital,name=Sint%20%Jans%e9%huis,name:en=St%20%John x4.8900000 y52.3700000");
  assert.equal(node.osmId, "n42");
  assert.equal(node.name, "Sint Janséhuis");
  assert.equal(node.aliases, "St John");
  assert.equal(node.categories, "amenity hospital amenity=hospital");
  assert.equal(node.latitude, 52.37);
  assert.equal(node.longitude, 4.89);
  assert.equal(parseOplNode("n7 v1 dV c0 t i0 u Thighway=crossing x5.2 y52.2"), null);
  assert.equal(parseOplNode("w7 v1 Tname=Way"), null);
});

test("a category near a place gives the nearest objects with distances", async () => {
  const found = await arviro.search({ source: "maps", query: "Welk ziekenhuis is er in Testdorp?" });
  assert.deepEqual(found.results.map((hit) => hit.name), ["Streekziekenhuis Testdorp", "Ziekenhuis Anderdorp"]);
  assert.equal(found.results[0].near, "Testdorp");
  assert.equal(found.results[0].category, "hospital");
  assert.ok(found.results[0].distanceKm < 1);
  assert.ok(found.results[1].distanceKm > 20 && found.results[1].distanceKm < 75);
  assert.match(found.resultPolicy, /do not calculate distances/);
});

test("Dutch compounds and English words select the same category", async () => {
  const compound = await arviro.search({ source: "maps", query: "streekziekenhuis bij Anderdorp" });
  assert.equal(compound.results[0].name, "Ziekenhuis Anderdorp");
  const english = await arviro.search({ source: "maps", query: "pharmacy near Testdorp" });
  assert.deepEqual(english.results.map((hit) => hit.name), ["Apotheek Centrum"]);
});

test("a place named after a category word does not win from the place that is meant", async () => {
  const found = await arviro.search({ source: "maps", query: "Welke apotheek zit het dichtst bij het station van Testdorp?" });
  assert.equal(found.results[0].near, "Testdorp");
  assert.deepEqual(found.results.map((hit) => hit.name), ["Apotheek Centrum"]);
  // The hamlet is still found by its name.
  const byName = await arviro.search({ source: "maps", query: "Het Station" });
  assert.ok(byName.results.some((hit) => hit.name === "Het Station"));
});

test("other questions are matched against names", async () => {
  const found = await arviro.search({ source: "maps", query: "Apotheek Centrum" });
  assert.equal(found.results[0].name, "Apotheek Centrum");
  assert.equal(found.results[0].distanceKm, undefined);
  const none = await arviro.search({ source: "maps", query: "Zzqxv" });
  assert.equal(none.results.length, 0);
  // A question without usable words finds nothing; it must not match the words of a placeholder query.
  const onlyStopwords = await arviro.search({ source: "maps", query: "what is the" });
  assert.equal(onlyStopwords.results.length, 0);
});

test("map results cannot be read further", async () => {
  await assert.rejects(arviro.read({ source: "maps", path: "x" }), /cannot be read further/);
});
