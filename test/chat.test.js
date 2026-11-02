import assert from "node:assert/strict";
import test from "node:test";
import { checkCitations, createLedger, isEmptyAnswer } from "../src/chat.js";

function ledger() {
  const result = createLedger();
  result.record("search_library", { source: "library", query: "burn" }, JSON.stringify({
    source: "library",
    results: [
      { title: "First aid at home", read: { source: "library", path: "manuals/first-aid.md", offset: 1 } },
      { title: "Water", read: { source: "library", path: "manuals/water.md", offset: 1 } },
    ],
  }));
  result.record("search_library", { source: "wikipedia", query: "Gouda" }, JSON.stringify({
    source: "wikipedia",
    results: [
      { title: "Gouda", read: { source: "wikipedia", path: "/kiwix/content/wikipedia_nl_all_nopic_2026-04/Gouda" } },
      { title: "Mercurius (planeet)", read: { source: "wikipedia", path: "/kiwix/content/wikipedia_nl_all_nopic_2026-04/Mercurius_(planeet)" } },
    ],
  }));
  result.record("search_library", { source: "maps", query: "hospital" }, JSON.stringify({ source: "maps", results: [{ name: "Streekziekenhuis Testdorp", distanceKm: 1.2 }] }));
  result.record("read_document", { source: "library", path: "manuals/first-aid.md" }, "source: library\npath: manuals/first-aid.md\n1 | # First aid");
  // A PDF that was read without a search result in this ledger: only its file name is known.
  result.record("read_document", { source: "library", path: "05-survival/documents/who-technical-note-05-emergency-treatment-drinking-water.pdf" }, "source: library\npath: 05-survival/documents/who-technical-note-05-emergency-treatment-drinking-water.pdf\npage 1");
  result.record("read_document", { source: "library", path: "manuals/missing.md" }, "read_document could not do this: That document does not exist.");
  return result;
}

test("the ledger keeps what was read and what was only seen", () => {
  const known = ledger();
  assert.deepEqual([...known.read.values()][0], { source: "library", path: "manuals/first-aid.md", title: "First aid at home" });
  assert.deepEqual(known.all().map((item) => item.title), ["First aid at home", null, "Water", "Gouda", "Mercurius (planeet)", "Streekziekenhuis Testdorp"]);
  assert.deepEqual([...known.sources].sort(), ["library", "maps", "wikipedia"]);
});

test("checkCitations names what no tool showed, and accepts what one did", () => {
  const known = ledger();
  assert.deepEqual(checkCitations("Cool it ten minutes (library: manuals/first-aid.md, lines 10-11).", known), []);
  assert.deepEqual(checkCitations("See library/manuals/first-aid.md and /kiwix/content/wikipedia_nl_all_nopic_2026-04/Gouda.", known), []);
  assert.deepEqual(checkCitations("Zie (/kiwix/content/wikipedia_nl_all_nopic_2026-04/Mercurius_(planeet)).", known), [], "brackets that belong to a title stay");
  assert.deepEqual(checkCitations("See [kiwix/content/wikipedia_nl_all_nopic_2026-04/Gouda_(stad)].", known), ["kiwix/content/wikipedia_nl_all_nopic_2026-04/Gouda_(stad)"]);
  assert.deepEqual(checkCitations("See manuals/made-up.pdf, page 3.", known), ["manuals/made-up.pdf"]);
  assert.deepEqual(checkCitations("Web: https://example.org/guide.pdf and 1/2 cup.", known), [], "web links and fractions are not library paths");
  assert.deepEqual(checkCitations("Answer.\n\nSources: First aid at home (library); Gouda; Streekziekenhuis Testdorp", known), []);
  assert.deepEqual(checkCitations("Answer.\n\nBronnen:\n- First aid at home\n- Het Rode Kruis handboek\n\nTot ziens.", known), ["Het Rode Kruis handboek"]);
  assert.deepEqual(checkCitations("Answer.\n\nSources: none (from my own knowledge)", known), []);
  assert.deepEqual(checkCitations("Answer.\n\n**Sources:** wikipedia; library", known), [], "a source id alone names a source that was searched");
  assert.deepEqual(checkCitations("No sources line and no paths.", known), []);
  assert.deepEqual(checkCitations("Sources: Gouda", createLedger()), ["Gouda"], "nothing is known in a turn without lookups");
  // A document cited in the model's own words: its title or file name, with punctuation, small words and pages.
  assert.deepEqual(checkCitations("Answer.\n\nBronnen: WHO Technical Note 05: Emergency treatment of drinking-water at the point of use (Pagina's 1-2): boil first", known), []);
  assert.deepEqual(checkCitations("Answer.\n\nSources: First aid (library, lines 10-11)", known), [], "a shortened title");
  assert.deepEqual(checkCitations("Answer.\n\nSources: WHO Technical Note 07: Cleaning wells", known), ["WHO Technical Note 07: Cleaning wells"], "another note of the same series is not the one read");
  assert.deepEqual(checkCitations("Answer.\n\nSources: Water purification handbook", known), ["Water purification handbook"], "one shared word is not enough");
});

test("checkCitations is linear in the length of the answer", () => {
  const known = ledger();
  for (const hostile of ["a/".repeat(200_000), `${"x".repeat(400_000)}/`, `Sources: ${"; a".repeat(100_000)}`, "/".repeat(400_000), `x/${")".repeat(20_000)}`, `(${"(".repeat(200_000)}a/b.md`, `Sources: ${"word ".repeat(100_000)}`]) {
    const started = Date.now();
    checkCitations(hostile, known);
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  }
});

test("isEmptyAnswer: nothing, or a tool call written out", () => {
  assert.equal(isEmptyAnswer(""), true);
  assert.equal(isEmptyAnswer("  \n"), true);
  assert.equal(isEmptyAnswer('<tool_call>{"name": "search_library"}</tool_call>'), true);
  assert.equal(isEmptyAnswer('{"name": "search_library", "arguments": {}}'), true);
  assert.equal(isEmptyAnswer("Cool the burn for ten minutes."), false);
});
