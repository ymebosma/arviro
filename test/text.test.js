import assert from "node:assert/strict";
import test from "node:test";
import {
  chunksFromLines, chunksFromPages, decodeEntities, elementText, extractEntityLookup, ftsQuery, htmlToText, levenshtein,
  normalizePathPrefix, numberedLines, properNamePhrases, properNames, squeezeSpaces, stripTags, titleFromText, tokensFor, UserInputError,
} from "../src/text.js";

/** Run `work` and fail when it takes longer than a second: guards against patterns that backtrack. */
function fast(label, work) {
  const started = Date.now();
  work();
  assert.ok(Date.now() - started < 1000, `${label} took ${Date.now() - started} ms`);
}

test("tokensFor drops stopwords and diacritics", () => {
  assert.deepEqual(tokensFor("Hoe maak ik drinkwater veilig tijdens een stroomuitval?"), ["drinkwater", "tijdens", "stroomuitval"]);
  assert.deepEqual(tokensFor("What is the café in Zürich?"), ["cafe", "zurich"]);
});

test("ftsQuery builds a prefix OR-query, survives quotes, and is null without usable words", () => {
  assert.equal(ftsQuery("burn wounds"), '"burn"* OR "wounds"*');
  assert.equal(ftsQuery('say "hi"'), '"say"* OR "hi"*');
  assert.equal(ftsQuery("de het een"), null);
});

test("chunksFromPages keeps page numbers for text with form feeds", () => {
  const chunks = chunksFromPages(`${"first page line that is long enough to keep\n".repeat(3)}\f${"second page line that is long enough to keep\n".repeat(3)}`);
  assert.deepEqual(chunks.map((chunk) => chunk.page), [1, 2]);
});

test("chunksFromLines overlaps long texts by a few lines and adds no tail passages", () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1} ${"x".repeat(100)}`);
  const chunks = chunksFromLines(lines.join("\n"), 1500, 3);
  assert.deepEqual(chunks.map((chunk) => [chunk.lineStart, chunk.lineEnd]), [[1, 14], [12, 25], [23, 36], [34, 40]]);
  assert.equal(chunksFromLines("a line that is long enough to become a passage on its own\r\nsecond line\r\n")[0].lineEnd, 3);
});

test("squeezeSpaces removes layout padding but keeps lines", () => {
  assert.equal(squeezeSpaces("Title          12   \n\n  indented\tok\t\t\tend \n"), "Title  12\n\n  indented\tok  end\n");
  fast("a very long run of spaces", () => squeezeSpaces(`${" ".repeat(2_000_000)}x`));
});

test("htmlToText removes markup, decodes entities once and starts a line per block", () => {
  assert.equal(htmlToText("<p>Fish &amp; chips &lt;3</p><script>alert(1)</script>").trim(), "Fish & chips <3");
  assert.equal(htmlToText("&amp;lt;").trim(), "&lt;");
  assert.deepEqual(htmlToText("<h1>Title</h1><p>One</p><ul><li>a</li><li>b <b>bold</b></li></ul>").split("\n").filter(Boolean), ["Title", "One", "a", "b bold"]);
  assert.equal(stripTags("<div>one</div>\n<div> two </div>"), "one two");
});

test("htmlToText drops script and style blocks, also unclosed ones, but not similar tag names", () => {
  assert.equal(htmlToText("before<SCRIPT type='x'>var a = '<p>';</SCRIPT>after").replace(/\s+/g, " ").trim(), "before after");
  assert.equal(htmlToText("keep<style>p { color: red }").trim(), "keep");
  assert.equal(htmlToText("<scripture>verse</scripture>").trim(), "verse");
  assert.equal(elementText("<html><head><TITLE lang='nl'>De titel</TITLE></head></html>", "title"), "De titel");
  assert.equal(elementText("<p>no title</p>", "title"), null);
});

test("decodeEntities leaves impossible character codes alone", () => {
  assert.equal(decodeEntities("&#65;&#x42;&#99999999;&#xD800;"), "AB&#99999999;&#xD800;");
});

test("hostile documents are processed in linear time", () => {
  fast("many unclosed tags", () => htmlToText("<".repeat(300_000)));
  fast("many unclosed block tags", () => htmlToText("<p ".repeat(200_000)));
  fast("many unclosed scripts", () => htmlToText("<script>".repeat(100_000)));
  fast("many blank lines", () => titleFromText("a.md", "\n".repeat(300_000)));
  fast("a long line of spaces", () => titleFromText("a.md", `${" ".repeat(300_000)}x`));
  fast("many ampersands", () => decodeEntities("&#".repeat(300_000)));
});

test("titleFromText prefers the first heading", () => {
  assert.equal(titleFromText("a/b/first-aid_guide.md", "intro\n# First aid\n"), "First aid");
  assert.equal(titleFromText("a/b/first-aid_guide.md", "no heading"), "first aid guide");
});

test("extractEntityLookup recognises who-is questions and bare names", () => {
  assert.equal(extractEntityLookup("Ken je Gregor Kobel?"), "Gregor Kobel");
  assert.equal(extractEntityLookup("Who is Ada Lovelace?"), "Ada Lovelace");
  assert.equal(extractEntityLookup("Gregor Kobel"), "Gregor Kobel");
  assert.equal(extractEntityLookup("Hoe zuiver ik water?"), null);
});

test("proper names are found, also with letters outside ASCII", () => {
  assert.deepEqual(properNamePhrases("Hoe goed is Gregor Kobel bij Borussia Dortmund Twee?"), ["Borussia Dortmund Twee", "Gregor Kobel"]);
  assert.deepEqual(properNamePhrases("Reis door Österreich Ungarn"), ["Österreich Ungarn"]);
  assert.deepEqual(properNames("Waar ligt België ten opzichte van Çanakkale?"), ["Waar", "België", "Çanakkale"]);
});

test("levenshtein ignores case and accents", () => {
  assert.equal(levenshtein("Gregor Kobelx", "gregor kobel"), 1);
  assert.equal(levenshtein("Zürich", "zurich"), 0);
});

test("numberedLines stops at the line and character limits and marks a cut line", () => {
  const lines = ["one", "two", "x".repeat(1700), "four"];
  const all = numberedLines(lines, 1, 10, 10_000);
  assert.equal(all.rows[2], `3: ${"x".repeat(1600)} [line cut, 100 more characters]`);
  assert.deepEqual([all.first, all.last, all.next], [1, 4, null]);
  const two = numberedLines(lines, 1, 2, 10_000);
  assert.deepEqual([two.rows.length, two.last, two.next], [2, 2, 3]);
  const tight = numberedLines(lines, 1, 10, 8);
  assert.deepEqual([tight.rows, tight.next], [["1: one"], 2]);
});

test("normalizePathPrefix accepts folders and rejects traversal", () => {
  assert.equal(normalizePathPrefix("/manuals/first aid/"), "manuals/first aid");
  assert.equal(normalizePathPrefix(""), "");
  assert.throws(() => normalizePathPrefix("../etc"), UserInputError);
  assert.throws(() => normalizePathPrefix("a;b"), UserInputError);
});
