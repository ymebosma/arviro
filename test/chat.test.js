import assert from "node:assert/strict";
import test from "node:test";
import { checkCitations, createLedger, isEmptyAnswer, isUnreadableToolCall } from "../src/chat.js";

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
  // From the test on the Mac: a one-word title from the search results, pointers to pages of what was read,
  // and a title in quotation marks with a line number.
  assert.deepEqual(checkCitations('Gouda ligt in Zuid-Holland.\n\nBron: Wikipedia (Nederlandstalig), artikel "Gouda"', known), []);
  assert.deepEqual(checkCitations("Antwoord.\n\nBron: WHO Technical Note 05\n- Werking: Pagina 6-7 (\"Principles of solid fuel gasification\", …)\n- Materialen: Pagina 5 en 11 (Abstract en Introductie, …)", known), []);
  assert.deepEqual(checkCitations('Antwoord.\n\nBron: Wikipedia, artikel "Mercurius (planeet)" (regel 6)', known), []);
  assert.deepEqual(checkCitations('Antwoord.\n\nBron: Wikipedia, artikel "Utrecht"', known), ['Wikipedia, artikel "Utrecht"'], "a quoted title that was never seen");
  const unread = createLedger();
  unread.record("search_library", { source: "library", query: "x" }, JSON.stringify({ source: "library", results: [{ title: "Water", read: { source: "library", path: "manuals/water.md" } }] }));
  assert.deepEqual(checkCitations("Antwoord.\n\nBronnen:\n- Pagina 6-7", unread), ["Pagina 6-7"], "a page of nothing that was read");
});

test("checkCitations accepts real sources in the model's own words (issue 11), and still names made-up ones", () => {
  const known = createLedger();
  known.record("search_library", { source: "maps", query: "pharmacy Testdorp" }, JSON.stringify({ source: "maps", results: [{ name: "Apotheek Centrum", distanceKm: 0.4 }] }));
  known.record("search_library", { source: "wikipedia_nl_all", query: "Gouda" }, JSON.stringify({ source: "wikipedia_nl_all", results: [{ title: "Gouda", read: { source: "wikipedia_nl_all", path: "/kiwix/content/wikipedia_nl_all_nopic_2026-04/Gouda" } }] }));
  known.record("search_library", { source: "mdwiki", query: "dehydration" }, JSON.stringify({ source: "mdwiki", results: [{ title: "Dehydration", read: { source: "mdwiki", path: "/kiwix/content/mdwiki_en_all_maxi_2026-09/Dehydration" } }] }));
  known.record("read_document", { source: "mdwiki", path: "/kiwix/content/mdwiki_en_all_maxi_2026-09/Dehydration" }, "source: mdwiki\nlines: 1-80 of 300\n1 | Dehydration");
  known.record("search_library", { source: "offline", query: "error codes" }, JSON.stringify({ source: "offline", results: [{ title: "Boiler manual", page: 78, read: { source: "offline", path: "folder/documents/some-handbook-2021.pdf", offset: 78 } }] }));
  known.record("read_document", { source: "offline", path: "folder/documents/some-handbook-2021.pdf", offset: 78 }, "source: offline\npath: folder/documents/some-handbook-2021.pdf\npage 78\n78.1 | Error codes\npage 79\n79.1 | E12");
  const sources = [{ id: "maps", description: "OpenStreetMap places and amenities, with distances" }, { id: "wikipedia_nl_all", description: "Wikipedia (offline): general knowledge" }, { id: "mdwiki", description: "MDWiki: medical articles" }, { id: "offline", description: "Manuals of the house" }];
  const flagged = (item) => checkCitations(`Answer.\n\nSources:\n- ${item}`, known, { sources });
  for (const real of [
    'OpenStreetMap (maps), category "pharmacy", region Testdorp',
    "OpenStreetMap via maps",
    "Dutch Wikipedia, article about Gouda",
    "Nederlandse Wikipedia, artikel over Gouda",
    "[mdwiki - Dehydration](/kiwix/content/mdwiki_en_all_maxi_2026-09/Dehydration) (general symptoms)",
    "folder/documents/some-handbook-2021.pdf",
    ".../documents/some-handbook-2021.pdf",
    'Boiler manual (PDF), page 78-79, section "Error codes"',
    "Ketelhandleiding 2021*, hoofdstuk 13 (offline, p. 78–79)",
    'it says explicitly: "Cool the burn for at least ten minutes under running water"',
    "Note: although the passages I read do not name the model, the steps are the same",
    "see also p. 265–266 about cleaning)",
    "MDWiki (medical articles)",
    "Manuals of the house, page 78",
  ]) assert.deepEqual(flagged(real), [], real);
  assert.deepEqual(checkCitations("See `.../documents/some-handbook-2021.pdf` and (folder/documents/some-handbook-2021.pdf, p. 78).", known, { sources }), []);
  // What no search or read showed is still pointed out.
  for (const madeUp of [
    "Imaginary Handbook, page 12",
    "Ketelhandleiding 2021, p. 300",
    "Mayo Clinic: Dehydration in children",
    "Wikipedia, article about Utrecht",
    ".../documents/another-handbook.pdf",
    "Red Cross first aid guide (2019)",
  ]) assert.equal(flagged(madeUp).length, 1, madeUp);
  // Without a map search, the word "maps" names nothing.
  const noMap = createLedger();
  noMap.record("search_library", { source: "library", query: "x" }, JSON.stringify({ source: "library", results: [{ title: "Water", read: { source: "library", path: "manuals/water.md" } }] }));
  assert.deepEqual(checkCitations("Answer.\n\nSources: OpenStreetMap via maps", noMap), ["OpenStreetMap via maps"]);
});

test("checkCitations accepts a title in another spelling than the file name, and the title a document prints", () => {
  const known = createLedger();
  const results = (list) => JSON.stringify({ source: "library", results: list.map(([path, title]) => ({ title, read: { source: "library", path } })) });
  known.record("search_library", { source: "library", query: "manual" }, results([
    ["manuals/example-car-2025plus-manual-nl.pdf", "example car 2025plus manual nl"],
    ["manuals/example-tv-x100-e-manual-nl.pdf", "example tv x100 e manual nl"],
    ["manuals/example-tv-x100-user-manual-nl.pdf", "example tv x100 user manual nl"],
    ["water/technical-note-01-cleaning-and-disinfecting-wells.pdf", "technical note 01 cleaning and disinfecting wells"],
    ["water/example-org-household-water-2019.pdf", "example org household water 2019"],
  ]));
  known.record("read_document", { source: "library", path: "water/technical-note-01-cleaning-and-disinfecting-wells.pdf" }, "source: library\npage 1\n1.1 | Cleaning and disinfecting wells");
  known.record("read_document", { source: "library", path: "water/example-org-household-water-2019.pdf" }, "source: library\npage 1\n1.1 | Safe water at home\n1.2 | A practical guide to storing and treating\n1.3 | household water\n1.4 | www.example.org");
  const sources = [{ id: "library", description: "Documents of the household" }];
  const flagged = (item) => checkCitations(`Answer.\n\nSources:\n- ${item}`, known, { sources });
  for (const real of [
    // "2025+" for "2025plus", with a page and a quoted section behind it.
    'Manual Example Car 2025+, page 270 (section: "Opening the doors")',
    // A plural for two documents.
    "offline library, Example TV X100 manuals",
    // "1" for "01", and a shortened title in quotation marks.
    'Technical Note 1 "Cleaning wells"',
    // The title printed on the first page, which the file name does not hold.
    "Safe water at home (www.example.org)",
    "Safe water at home: A practical guide to storing and treating household water",
  ]) assert.deepEqual(flagged(real), [], real);
  for (const madeUp of [
    'Technical Note 7 "Cleaning wells"',
    "Example TV X200 manuals",
    "Example Car 2024 manual",
    "Safe water for travellers (www.example.org)",
    "Safe water",
  ]) assert.deepEqual(flagged(madeUp), [madeUp], madeUp);
});

test("checkCitations accepts a printed title that a search result or a later page showed, and text that is not a path", () => {
  const known = createLedger();
  const results = (list) => JSON.stringify({ source: "offline", results: list.map(([path, title, excerpt]) => ({ title, excerpt, read: { source: "offline", path } })) });
  known.record("search_library", { source: "offline", query: "water" }, results([
    // The file names are abbreviations; the title stands in the text.
    ["handbook/en-exfh-2025-13.pdf", "en exfh 2025 13", "Example Field Handbook\nChapter 13: Topic\n151\nWhen the water is cloudy ..."],
    ["router/exr-ig-2.pdf", "exr ig 2", "Status LEDs ..."],
    ["water/technical-note-11-measuring-levels.pdf", "technical note 11 measuring levels", "The level should be between 0.2 and 0.5 mg/l"],
  ]));
  // A later page, with the title in its header, far beyond the beginning of the read.
  known.record("read_document", { source: "offline", path: "router/exr-ig-2.pdf", offset: 30 }, `source: offline\npath: router/exr-ig-2.pdf\npage 30\n${"30.1 | A long page about cabling. ".repeat(200)}\npage 31\n31.1 | Example Router Installation Guide 25\n31.2 | LEDs`);
  const sources = [{ id: "offline", description: "Manuals and handbooks" }];
  const flagged = (item) => checkCitations(`Answer.\n\nSources:\n- ${item}`, known, { sources });
  for (const real of [
    "Example Field Handbook*, Chapter 13: Topic, p. 151 (PDF page 1)",
    'Example Router Installation Guide*, pages 24 and 53 ("LEDs" and "Identifying Errors")',
    // "library" is what the source is, not a name; the quotation in brackets is from the text.
    'offline library, Technical Note 11, page 4 ("between 0.2 and 0.5 mg/l")',
    "the offline library",
  ]) assert.deepEqual(flagged(real), [], real);
  for (const madeUp of ["offline library, Technical Note 12, page 4", "Imaginary Field Handbook, Chapter 13", "Example Router Service Manual, page 3"]) assert.deepEqual(flagged(madeUp), [madeUp], madeUp);
  // A page title in italics between the source and a section name.
  known.record("search_library", { source: "wikibooks_nl_all", query: "brood" }, JSON.stringify({ source: "wikibooks_nl_all", results: [{ title: "Kookboek/Brood", snippet: "Brood bakken", read: { source: "wikibooks_nl_all", path: "/kiwix/content/wikibooks_nl_all_2026-01/Kookboek/Brood" } }] }));
  const withBooks = [...sources, { id: "wikibooks_nl_all", description: "Wikibooks (offline): cookbook and manuals" }];
  for (const real of ['Wikibooks cookbook, *Brood*, section "Ingredients"', 'Wikibooks cookbook, **Kookboek/Brood**, section "Ingredients"']) assert.deepEqual(checkCitations(`Answer.\n\nSources:\n- ${real}`, known, { sources: withBooks }), [], real);
  const cake = 'Wikibooks cookbook, *Taart*, section "Ingredients"';
  assert.deepEqual(checkCitations(`Answer.\n\nSources:\n- ${cake}`, known, { sources: withBooks }), [cake]);
  // "3G/3.75G" is not a file; a path with a real extension still is.
  assert.deepEqual(checkCitations("The modem supports 3G/3.75G; see notes/unknown.md and backups/old.7z.", known, { sources }), ["notes/unknown.md", "backups/old.7z"]);
});

test("checkCitations is linear in the length of the answer", () => {
  const known = ledger();
  for (const hostile of ["a/".repeat(200_000), `${"x".repeat(400_000)}/`, `Sources: ${"; a".repeat(100_000)}`, "/".repeat(400_000), `x/${")".repeat(20_000)}`, `(${"(".repeat(200_000)}a/b.md`, `Sources: ${"word ".repeat(100_000)}`, `Sources: ${'"a '.repeat(100_000)}`, `Sources: ${"(pagina ".repeat(100_000)}`, `Sources: ${"p. 1, ".repeat(100_000)}`, `Sources: ${"a1".repeat(200_000)}`, `Sources: ${"*a ".repeat(100_000)}`, `Sources: ${"**".repeat(200_000)}`, `Sources: ${"0".repeat(400_000)}`, `Sources: ${"safe water at home ".repeat(50_000)}`, `Sources:\n${"- note: x\n".repeat(50_000)}`, "](".repeat(200_000), `Sources: ${".../".repeat(100_000)}a.pdf`, `Sources: ${"a: b - c (d, ".repeat(50_000)}`]) {
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

test("an error about a tool call Ollama could not read is told apart from other errors", () => {
  assert.equal(isUnreadableToolCall("Ollama answered 500: error parsing tool call: raw='<parameter=query>', err=expected element type <function> but have <parameter>"), true);
  assert.equal(isUnreadableToolCall("expected element type <function> but have <parameter>"), true);
  assert.equal(isUnreadableToolCall("XML syntax error on line 7: element <function> closed by </parameter>"), true);
  assert.equal(isUnreadableToolCall("Ollama answered 404: model \"nothing\" not found"), false);
  assert.equal(isUnreadableToolCall("Ollama answered 500: model requires more system memory"), false);
  assert.equal(isUnreadableToolCall(undefined), false);
});
