import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { factsIn, formatRow, formatSummary, loadEvalQuestions, saysNotFound, summarize } from "../src/eval.js";

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
});

test("the summary counts per model, and the lines say what went wrong", () => {
  const rows = [
    { question: "a", model: "m", searched: ["library"], reads: 1, answer: "x", seconds: 2, factsFound: 2, factsTotal: 2, missing: [], rightSource: true, notFoundOk: null, empty: false, unverified: [], rescued: false, thinkCut: false },
    { question: "b", model: "m", searched: [], reads: 0, answer: "", seconds: 4, factsFound: 0, factsTotal: 1, missing: ["lukewarm"], rightSource: false, notFoundOk: null, empty: true, unverified: ["made-up.md"], rescued: true, thinkCut: true },
    { question: "c", model: "m", searched: ["wikipedia"], reads: 0, answer: "not found", seconds: 3, factsFound: 0, factsTotal: 0, missing: [], rightSource: null, notFoundOk: true, empty: false, unverified: [], rescued: false, thinkCut: false },
  ];
  const summary = summarize("m", rows);
  assert.deepEqual(summary, { model: "m", questions: 3, errors: 0, answered: 2, facts: 67, searched: 67, rightSource: 50, read: 33, notFound: 100, madeUpSources: 1, rescued: 1, thinkCut: 1, secondsAverage: 3 });
  const table = formatSummary([{ model: "m", rows, summary }]);
  assert.match(table, /^model +questions +answered +facts/);
  assert.match(table, /\nm +3 +2 +67% +67% +50% +33% +100% +1 +1 +1 +3$/);
  assert.match(formatRow(rows[1], 1), /^ {2}2\. +4s +no search +WRONG SOURCE +facts 0\/1 \(missing: lukewarm\) +NO ANSWER +MADE-UP SOURCE: made-up\.md +second try +thinking cut +b$/);
  assert.match(formatRow({ ...rows[0], error: "Ollama is gone" }, 0), /ERROR Ollama is gone/);
});
