import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { askedInstead, asksBack, factsIn, formatRow, formatSummary, loadEvalQuestions, saveEval, saysNotFound, spread, summarize } from "../src/eval.js";

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "arviro-eval-test-"));
after(() => fs.rmSync(folder, { recursive: true, force: true }));
const write = (name, value) => { const file = path.join(folder, name); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; };

test("eval questions are read and checked", () => {
  const questions = loadEvalQuestions(write("q.json", { questions: [
    { question: "How long to cool a burn?", source: "library", facts: [["ten minutes", "10 minutes"], "lukewarm"] },
    "Plain question?",
    { question: "Weather tomorrow?", expect: "not-found", source: ["wikipedia", "wikivoyage"] },
  ] }));
  assert.deepEqual(questions[0], { question: "How long to cool a burn?", sources: ["library"], facts: [["ten minutes", "10 minutes"], ["lukewarm"]], expect: "answer" });
  assert.deepEqual(questions[1], { question: "Plain question?", sources: [], facts: [], expect: "answer" });
  assert.deepEqual(questions[2].sources, ["wikipedia", "wikivoyage"]);
  assert.equal(loadEvalQuestions(write("list.json", ["A question?"])).length, 1, "a plain list works too");
  assert.throws(() => loadEvalQuestions(write("bad.json", "{")), /Cannot read the questions/);
  assert.throws(() => loadEvalQuestions(write("empty.json", { questions: [] })), /has no questions/);
  assert.throws(() => loadEvalQuestions(write("noq.json", [{ facts: [] }])), /needs a "question"/);
  assert.throws(() => loadEvalQuestions(write("expect.json", [{ question: "x?", expect: "maybe" }])), /"expect" is/);
  assert.throws(() => loadEvalQuestions(write("fact.json", [{ question: "x?", facts: [[""]] }])), /at least one wording/);
  // The example in the repository is valid.
  const example = fileURLToPath(new URL("../examples/eval.example.json", import.meta.url));
  assert.ok(loadEvalQuestions(example).length >= 5);
});

test("facts are found whatever the case and accents; not-found answers are recognised", () => {
  assert.deepEqual(factsIn("Koel de brandwond TIEN minuten met lauw water.", [["ten minutes", "tien minuten"], ["lauw"], ["ijs"]]), [["ten minutes", "tien minuten"], ["lauw"]]);
  assert.deepEqual(factsIn("Café crème", [["cafe creme"]]), [["cafe creme"]]);
  assert.equal(saysNotFound("I could not find that in the library."), true);
  assert.equal(saysNotFound("Dat staat niet in de bibliotheek."), true);
  assert.equal(saysNotFound("Cool it for ten minutes."), false);
  // The Dutch answers from the test on the Mac.
  assert.equal(saysNotFound("Ik kan dit telefoonnummer niet vinden in de lokale bibliotheek."), true);
  assert.equal(saysNotFound("Ik heb geen toegang tot internet en kan je dus niet vertellen wat het weer morgen wordt."), true);
  assert.equal(saysNotFound("Die informatie is niet in mijn lokale bibliotheek opgenomen."), true);
  assert.equal(saysNotFound("I can't find that in the library."), true);
  // Dutch puts the participle at the end of the clause: the denial and "gevonden" are far apart (issue 11).
  assert.equal(saysNotFound("Er is geen instructie voor het instellen van een Voorbeeld Apparaat (een soort apparaat) gevonden in de beschikbare lokale bibliotheken."), true);
  assert.equal(saysNotFound("Es wurde keine Anleitung für das Einrichten eines solchen Geräts in den Dokumenten gefunden."), true);
  // A denial in one sentence and a finding word in the next do not belong together.
  assert.equal(saysNotFound("Gebruik geen zeep. De informatie staat op pagina 12 van de handleiding."), false);
  assert.equal(saysNotFound("Do not use soap. The library has a page about it."), false);
  assert.equal(saysNotFound("The library doesn't have anything on it."), true);
  assert.equal(saysNotFound("Kook het water één minuut en laat het afkoelen."), false);
  assert.equal(asksBack("Is de buurvrouw een persoon wiens gegevens zijn opgenomen in `wiki`?"), true);
  assert.equal(asksBack('Bedoel je de stad of de kaas?"'), true);
  assert.equal(asksBack("Kook het water. Wil je meer weten? Lees dan verder."), false);
  assert.equal(asksBack(""), false);
  // Asked back instead of answering, or an answer with an offer at the end (the sourdough question on the Mac).
  const withFacts = { expect: "answer", facts: [["flour"], ["water"], ["salt"]] };
  const offer = "Mix flour, water and salt, and let it rise overnight. Wil je ook weten hoe je de starter bewaart?";
  assert.equal(askedInstead(offer, withFacts, 3), false);
  assert.equal(askedInstead("Bedoel je brood met gist of met zuurdesem?", withFacts, 0), true);
  const notFound = { expect: "not-found", facts: [] };
  assert.equal(askedInstead("Is de buurvrouw iemand uit de wiki?", notFound, 0), true);
  assert.equal(askedInstead("Dat staat niet in de bibliotheek. Zal ik in de notities zoeken?", notFound, 0), false);
  const noFacts = { expect: "answer", facts: [] };
  assert.equal(askedInstead("Welke stad bedoel je?", noFacts, 0), true);
  assert.equal(askedInstead(`${"Een volledig antwoord. ".repeat(20)}Nog iets?`, noFacts, 0), false);
  assert.equal(saysNotFound("You can find the river Alzette in the valley."), false);
  const started = Date.now();
  saysNotFound("niet ".repeat(100_000) + "vinden ".repeat(100_000));
  saysNotFound("geen. ".repeat(100_000));
  assert.ok(Date.now() - started < 1000);
});

test("the summary counts per model, and the lines say what went wrong", () => {
  const rows = [
    { question: "a", model: "m", searched: ["library", "library"], repeated: 1, reads: 1, answer: "x", seconds: 2, factsFound: 2, factsTotal: 2, missing: [], rightSource: true, notFoundOk: null, empty: false, unverified: [], rescued: false, thinkCut: false },
    { question: "b", model: "m", searched: [], reads: 0, answer: "", seconds: 4, factsFound: 0, factsTotal: 1, missing: ["lukewarm"], rightSource: false, notFoundOk: null, empty: true, unverified: ["made-up.md"], rescued: true, thinkCut: true, reasked: 1 },
    { question: "c", model: "m", searched: ["wikipedia", "wikipedia", "wikipedia", "library"], reads: 0, answer: "not found", askedBack: false, seconds: 3, factsFound: 0, factsTotal: 0, missing: [], rightSource: null, notFoundOk: true, empty: false, unverified: [], rescued: false, thinkCut: false },
  ];
  rows[1].askedBack = true;
  const summary = summarize("m", rows);
  assert.deepEqual(summary, { model: "m", questions: 3, errors: 0, answered: 2, facts: 67, searched: 100, rightSource: 100, read: 50, notFound: 100, madeUpSources: 1, repeatedSearches: 1, searchesAverage: 2, askedBack: 1, rescued: 1, thinkCut: 1, reasked: 1, checked: 0, checkChanged: 0, checkSetAside: 0, factsBeforeCheck: 67, secondsAverage: 3 });
  const table = formatSummary([{ model: "m", run: 1, rows, summary }]);
  assert.match(table, /^model +questions +answered +facts/);
  assert.match(table, /thinking cut +asked again +seconds$/m);
  assert.match(table, /\nm +3 +2 +67% +100% +100% +50% +100% +1 +1 +2 +1 +1 +1 +1 +3$/);
  assert.match(formatRow(rows[2], 2), /searched wikipedia x3, library +MANY SEARCHES \(4\)/);
  assert.match(formatRow(rows[1], 1), /ASKED BACK/);
  assert.match(formatRow(rows[0], 0), /searched library x2 +REPEATED SEARCH x1 +read 1/);
  const long = formatRow({ ...rows[1], unverified: ["A".repeat(100), "b", "c", "d", "e"] }, 1);
  assert.match(long, /MADE-UP SOURCE: A{57}\.\.\.; b; c \(\+2\)/);
  assert.match(formatRow(rows[1], 1), /^ {2}2\. +4s +facts 0\/1 \(missing: lukewarm\) +ASKED BACK +NO ANSWER +MADE-UP SOURCE: made-up\.md +second try +thinking cut +asked again +b$/);
  assert.match(formatRow({ ...rows[0], error: "Ollama is gone" }, 0), /ERROR Ollama is gone/);
  // An answer without a search is still "no search" and can have the wrong source; only a turn with nothing at all is left out.
  assert.match(formatRow({ ...rows[1], empty: false, answer: "From memory." }, 1), /no search +WRONG SOURCE/);
  assert.equal(summarize("m", [rows[0], { ...rows[1], empty: false }]).searched, 50);
});

test("several runs of a model give the mean and the range per column, and a file per run", () => {
  const row = (extra) => ({ question: "a", model: "m", searched: ["library"], reads: 1, answer: "x", seconds: 2, factsFound: 1, factsTotal: 2, missing: [], rightSource: null, notFoundOk: null, empty: false, unverified: [], ...extra });
  const runs = [[row({ factsFound: 2 }), row({ unverified: ["made-up.md"] })], [row({}), row({})], [row({ factsFound: 2 }), row({ factsFound: 2, seconds: 5 })]];
  const results = runs.map((rows, index) => ({ model: "m", run: index + 1, rows, summary: summarize("m", rows) }));
  const numbers = spread(results.map((result) => result.summary));
  assert.equal(numbers.runs, 3);
  assert.deepEqual(numbers.facts, { mean: 75, min: 50, max: 100 });
  assert.deepEqual(numbers.madeUpSources, { mean: 0.3, min: 0, max: 1 });
  assert.equal(numbers.rightSource, null, "a column that applies to no question stays empty");
  // One more model with a single run: its line has plain numbers.
  const other = { model: "n", run: 1, rows: runs[1], summary: summarize("n", runs[1]) };
  const table = formatSummary([...results, other]).split("\n");
  assert.match(table[0], /^model +runs +questions +answered +facts/);
  assert.match(table[1], /^m +3 +2 +2 +75% \(50-100\) +100% +- +100% +- +0 +0\.3 \(0-1\) +1 +0 +0 +0 +0 +2\.5 \(2-3\.5\)$/);
  assert.match(table[2], /^n +1 +2 +2 +50% +100% +- +100% +- +0 +0 +1 +0 +0 +0 +0 +2$/);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "arviro-eval-"));
  try {
    const files = saveEval([...results, other], folder, "stamp").map((file) => path.basename(file));
    assert.deepEqual(files, ["stamp-m-run1.jsonl", "stamp-m-run2.jsonl", "stamp-m-run3.jsonl", "stamp-n.jsonl"]);
    const first = JSON.parse(fs.readFileSync(path.join(folder, "stamp-m-run2.jsonl"), "utf8").split("\n")[0]);
    assert.equal(first.run, 2);
    assert.equal(first.runs, 3);
    assert.equal(first.summary.facts, 50);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("the check round is scored: the facts before it next to the facts after it", () => {
  const row = (extra) => ({ question: "a", model: "m", searched: ["library"], reads: 1, answer: "x", seconds: 2, factsFound: 2, factsTotal: 2, missing: [], rightSource: null, notFoundOk: null, empty: false, unverified: [], ...extra });
  const rows = [row({ checked: true, checkChanged: true, factsBeforeCheck: 0 }), row({ checked: true, checkChanged: false, factsBeforeCheck: 2 }), row({ factsFound: 1 })];
  const summary = summarize("m", rows);
  assert.equal(summary.facts, 83);
  assert.equal(summary.factsBeforeCheck, 50, "the unchecked answer counts as it is");
  assert.equal(summary.checked, 2);
  assert.equal(summary.checkChanged, 1);
  const table = formatSummary([{ model: "m", run: 1, rows, summary }]).split("\n");
  assert.match(table[0], /seconds +checked +check changed +check set aside +facts before check$/);
  assert.match(table[1], / 2 +1 +0 +50%$/);
  assert.match(formatRow({ ...rows[1], checkSetAside: true }, 1), /check answer set aside +a$/);
  assert.equal(summarize("m", [{ ...rows[1], checkSetAside: true }]).checkSetAside, 1);
  assert.match(formatRow(rows[0], 0), /check changed the answer \(facts before: 0\/2\)/);
  assert.match(formatRow(rows[1], 1), /check kept the answer +a$/);
  // Without a check round the table has no columns for it.
  const plain = [row({})];
  assert.doesNotMatch(formatSummary([{ model: "m", run: 1, rows: plain, summary: summarize("m", plain) }]), /checked/);
});
