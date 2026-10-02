import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { readDocument, resolveInside } from "../src/reader.js";
import { ServiceError, UserInputError } from "../src/text.js";
import { fixtureConfig, makeFixture } from "./helpers.js";

const fixture = makeFixture();
const config = fixtureConfig(fixture);
const source = config.sources.library;
const pdftotext = config.tools.pdftotext;
after(() => fixture.cleanup());

const rows = (result) => result.text.split("\n");

test("a text document is returned as numbered lines", async () => {
  const result = await readDocument(source, "manuals/first-aid.md", { offset: 5, limit: 3 });
  assert.deepEqual(rows(result), [
    "source: library",
    "path: manuals/first-aid.md",
    "lines: 5-7 of 12",
    "5: ## Bleeding",
    "6: ",
    "7: Press firmly on a bleeding wound with a clean dressing and raise the limb.",
    "more: continue with offset 8",
  ]);
});

test("the character budget cuts a long read and says where to continue", async () => {
  const long = Array.from({ length: 50 }, (_, index) => `line ${index + 1} ${"x".repeat(90)}`).join("\n");
  fs.writeFileSync(path.join(fixture.library, "manuals/long.txt"), long);
  const result = await readDocument(source, "manuals/long.txt", { maxChars: 1000 });
  assert.equal(rows(result)[2], "lines: 1-9 of 50");
  assert.equal(rows(result).at(-1), "more: continue with offset 10");
  const tail = await readDocument(source, "manuals/long.txt", { offset: 49 });
  assert.equal(rows(tail).at(-1).startsWith("50: line 50"), true);
  const beyond = await readDocument(source, "manuals/long.txt", { offset: 99 });
  assert.match(beyond.text, /No lines at offset 99; the document has 50 lines/);
});

test("a very long line is cut visibly", async () => {
  fs.writeFileSync(path.join(fixture.library, "manuals/minified.txt"), `short\n${"y".repeat(2000)}\n`);
  const result = await readDocument(source, "manuals/minified.txt");
  assert.equal(rows(result)[4], `2: ${"y".repeat(1600)} [line cut, 400 more characters]`);
});

test("a PDF is read by page, three pages at a time", async () => {
  const first = await readDocument(source, "manuals/checklist.pdf", { pdftotext });
  assert.deepEqual(rows(first), [
    "source: library",
    "path: manuals/checklist.pdf",
    "page 1",
    "1.1: Checklist page 1: torch, radio and spare batteries",
    "1.2:   item  one",
    "page 2",
    "2.1: Checklist page 2: torch, radio and spare batteries",
    "2.2:   item  one",
    "page 3",
    "3.1: Checklist page 3: torch, radio and spare batteries",
    "3.2:   item  one",
    "more: the next page is offset 4",
  ]);
  const last = await readDocument(source, "manuals/checklist.pdf", { offset: 4, pdftotext });
  assert.deepEqual(rows(last).slice(2), ["page 4", "4.1: Checklist page 4: torch, radio and spare batteries", "4.2:   item  one", "page 5", "5.1: Checklist page 5: torch, radio and spare batteries", "5.2:   item  one"]);
  const cut = await readDocument(source, "manuals/checklist.pdf", { offset: 4, limit: 1, pdftotext });
  assert.equal(rows(cut).at(-1), "truncated: page 4 was cut off here; the next page is offset 5");
});

test("a page past the end of a PDF gives a plain message, not an error", async () => {
  const beyond = await readDocument(source, "manuals/checklist.pdf", { offset: 6, pdftotext });
  assert.deepEqual(rows(beyond).slice(2), ["No text at page 6; the document may have fewer pages."]);
});

test("a PDF with a text copy is read from the copy, so pages match the search results", async () => {
  const result = await readDocument(source, "guides/documents/emergency-guide.pdf", { offset: 2, pdftotext });
  assert.deepEqual(rows(result), [
    "source: library",
    "path: guides/documents/emergency-guide.pdf",
    "page 2",
    "2.1: Page two explains evacuation routes and the emergency meeting point.",
  ]);
  const whole = await readDocument(source, "guides/documents/emergency-guide.pdf", { pdftotext: null });
  assert.match(whole.text, /1\.1: Emergency guide, page one\./);
  assert.doesNotMatch(whole.text, /more:/);
});

test("failures of pdftotext do not reveal where files are", async () => {
  const broken = path.join(fixture.root, "bin/pdftotext-broken");
  const failure = await readDocument(source, "manuals/checklist.pdf", { pdftotext: broken }).catch((error) => error);
  assert.ok(failure instanceof ServiceError);
  assert.equal(failure.message, "This PDF could not be converted to text.");
  const missing = await readDocument(source, "manuals/checklist.pdf", { pdftotext: null }).catch((error) => error);
  assert.ok(missing instanceof ServiceError);
  assert.ok(!missing.message.includes(fixture.root));
});

test("HTML is converted to text before reading", async () => {
  const result = await readDocument(source, "web/standalone.html");
  assert.match(result.text, /Close shutters & windows during a storm warning\./);
  assert.doesNotMatch(result.text, /<p>/);
});

test("a path may carry the source id as prefix", async () => {
  const result = await readDocument(source, "library/manuals/water.txt");
  assert.equal(result.path, "manuals/water.txt");
});

test("paths outside the source are refused", async () => {
  for (const attempt of ["../outside/secret.txt", "manuals/../../outside/secret.txt", path.join(fixture.root, "outside/secret.txt"), "..", ".hidden/secret.md", "manuals/.env", "manuals/water.txt\u0000.md", "a/".repeat(3000), ""]) {
    await assert.rejects(readDocument(source, attempt), UserInputError, attempt.slice(0, 40));
  }
});

test("a symlink that leaves the source is refused", async () => {
  fs.symlinkSync(path.join(fixture.root, "outside"), path.join(fixture.library, "manuals/link"));
  await assert.rejects(readDocument(source, "manuals/link/secret.txt"), /not part of this source/);
  assert.throws(() => resolveInside(source, "manuals/link/secret.txt"), UserInputError);
});

test("what the index skips cannot be read either: excluded folders and hidden folders behind a link", async () => {
  await assert.rejects(readDocument(source, "vendor/ignored.md"), /not part of this source/);
  fs.symlinkSync(path.join(fixture.library, ".hidden"), path.join(fixture.library, "manuals/visible"));
  await assert.rejects(readDocument(source, "manuals/visible/secret.md"), /not part of this source/);
  const custom = fixtureConfig(fixture, { sources: { library: { path: fixture.library, exclude: ["web"] } } }).sources.library;
  await assert.rejects(readDocument(custom, "web/standalone.html"), /not part of this source/);
});

test("folders and unsupported file types are refused", async () => {
  await assert.rejects(readDocument(source, "manuals"), /folder/);
  fs.writeFileSync(path.join(fixture.library, "manuals/archive.zip"), "PK");
  await assert.rejects(readDocument(source, "manuals/archive.zip"), /file type cannot be read/);
});
