// `arviro eval`: ask a fixed list of questions to one or more models, through exactly the code the Chat tab
// uses, and measure what small local models get wrong: not searching, searching the wrong source, not reading,
// missing the facts, giving no answer, and naming sources they never saw.
// The questions are the owner's, about the owner's library; examples/eval.example.json shows the format.
import fs from "node:fs";
import path from "node:path";
import { createChat } from "./chat.js";
import { ConfigError } from "./config.js";
import { normalizeComparable } from "./text.js";

const MAX_QUESTIONS = 500;
// Words an answer uses to say the library does not have something (English, Dutch, German, French).
const NOT_FOUND_PHRASES = [
  "not in the", "not found", "could not find", "couldn t find", "cannot find", "can t find", "no information", "does not contain", "doesn t contain", "not mentioned",
  "niet in de", "niet gevonden", "kon niet vinden", "kan niet vinden", "geen informatie", "staat niet", "niet te vinden", "kon ik niet", "kan ik niet",
  "nicht gefunden", "keine information", "nicht enthalten", "pas trouve", "aucune information",
];

/**
 * The questions of an eval file: { questions: [...] } or a plain list. Each question is
 * { question, source?: id or [ids], facts?: [[alternatives], ...], expect?: "answer" | "not-found" }.
 * A source matches when a searched source id equals it or starts with it ("wikipedia" matches "wikipedia_nl_all").
 */
export function loadEvalQuestions(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new ConfigError(`Cannot read the questions in ${file}: ${error.code || error.message}`); }
  const list = Array.isArray(raw) ? raw : raw?.questions;
  if (!Array.isArray(list) || !list.length) throw new ConfigError(`${file} has no questions: give a list, or { "questions": [...] }.`);
  if (list.length > MAX_QUESTIONS) throw new ConfigError(`${file} has more than ${MAX_QUESTIONS} questions.`);
  return list.map((entry, index) => {
    const label = `question ${index + 1}`;
    const item = typeof entry === "string" ? { question: entry } : entry;
    if (!item || typeof item !== "object" || typeof item.question !== "string" || item.question.trim().length < 2) throw new ConfigError(`${label} needs a "question".`);
    const facts = (item.facts ?? []).map((fact) => (Array.isArray(fact) ? fact : [fact]).map(String).filter((alternative) => alternative.trim()));
    if (facts.some((fact) => !fact.length)) throw new ConfigError(`${label}: every fact needs at least one wording.`);
    const expect = item.expect ?? "answer";
    if (!["answer", "not-found"].includes(expect)) throw new ConfigError(`${label}: "expect" is "answer" or "not-found".`);
    const sources = item.source == null ? [] : (Array.isArray(item.source) ? item.source : [item.source]).map(String);
    return { question: item.question.trim(), sources, facts, expect, ...(item.note ? { note: String(item.note) } : {}) };
  });
}

/** The facts an answer contains: each fact counts when one of its wordings is in the answer, ignoring case and accents. */
export function factsIn(answer, facts) {
  const text = normalizeComparable(answer);
  return facts.filter((fact) => fact.some((wording) => text.includes(normalizeComparable(wording))));
}

// Words that deny, and words about finding or having information. A denial near such a word says "it is not there"
// in more ways than a list of phrases can hold: "Ik kan dit telefoonnummer niet vinden in de lokale bibliotheek".
const DENIALS = new Set(["not", "no", "cannot", "unable", "don", "doesn", "isn", "couldn", "can", "niet", "geen", "nergens", "nicht", "kein", "keine", "keinen", "pas", "aucun", "aucune", "ni"]);
const NEEDS_T = new Set(["can", "don", "doesn", "isn", "couldn"]);
// Words that are about finding or holding information and little else: they count anywhere in the sentence of the
// denial, since Dutch and German put the participle at the end ("Er is geen instructie voor ... gevonden").
const FINDING = new Set([
  "find", "found", "contain", "contains", "available", "information", "library", "libraries", "source", "sources", "documents", "records", "mentioned", "listed", "included",
  "vinden", "gevonden", "vind", "bevat", "bevatten", "beschikbaar", "beschikbare", "informatie", "gegevens", "bibliotheek", "bibliotheken", "bron", "bronnen", "documenten", "opgenomen", "vermeld",
  "finden", "gefunden", "enthalten", "informationen", "bibliothek", "quelle", "quellen", "trouve", "trouver", "bibliotheque",
]);
// Everyday words that only say "not there" right next to the denial: "heb geen", "weet niet", "staat niet".
const FINDING_NEARBY = new Set(["know", "tell", "have", "has", "access", "data", "weet", "weten", "vertellen", "zeggen", "heb", "hebben", "toegang", "staat", "staan", "terug", "weiss"]);
const NEARBY = 6;
const SAME_SENTENCE = 20;

/**
 * Whether an answer says the library does not have it: a denial in the same sentence as a word about finding
 * (within twenty words), or within a few words of an everyday word such as "have" or "weet".
 */
export function saysNotFound(answer) {
  const whole = normalizeComparable(answer);
  if (NOT_FOUND_PHRASES.some((phrase) => whole.includes(phrase))) return true;
  for (const sentence of String(answer || "").split(/[.!?;\n]/)) {
    const words = normalizeComparable(sentence).split(" ");
    let denial = -Infinity;
    let finding = -Infinity;
    let nearby = -Infinity;
    for (const [index, word] of words.entries()) {
      // "can", "don" and the like only deny with the "t" of their contraction ("can't" becomes "can t").
      if (DENIALS.has(word) && (!NEEDS_T.has(word) || words[index + 1] === "t")) denial = index;
      if (FINDING.has(word)) finding = index;
      if (FINDING_NEARBY.has(word)) nearby = index;
      if (Math.abs(denial - finding) <= SAME_SENTENCE || Math.abs(denial - nearby) <= NEARBY) return true;
    }
  }
  return false;
}

/** Whether an answer ends with a question to the user ("Is de buurvrouw iemand uit de wiki?"). */
export function asksBack(answer) {
  const text = String(answer || "").trim();
  let end = text.length;
  while (end > 0 && "\"'”’»)*_ ".includes(text[end - 1])) end -= 1;
  return end > 0 && text[end - 1] === "?";
}

// An answer this short that ends with a question is the question, not an answer with an offer at the end.
const SHORT_ANSWER = 300;

/**
 * Whether the model asked back instead of answering: the answer ends with a question and holds no answer of its
 * own. A full answer that ends with an offer ("Wil je ook weten hoe je het bewaart?") is an answer.
 * @param {string} answer
 * @param {{ expect: string, facts: string[][] }} item
 * @param {number} factsFound
 */
export function askedInstead(answer, item, factsFound) {
  if (!asksBack(answer)) return false;
  if (item.expect === "not-found") return !saysNotFound(answer);
  if (item.facts.length) return factsFound === 0;
  return String(answer).trim().length <= SHORT_ANSWER;
}

// From this many searches for one question on, the line says so: one or two searches usually find it.
export const MANY_SEARCHES = 4;

/** One question through the chat: what the model did and how the answer scores. */
async function askOne(chat, model, item, sessionKey) {
  const started = Date.now();
  const row = { question: item.question, model, searched: [], searches: [], repeated: 0, reads: 0, answer: "", seconds: 0 };
  const searches = new Set();
  try {
    for await (const event of chat.run({ messages: [{ role: "user", content: item.question }], model, sessionKey })) {
      if (event.type === "tool" && event.name === "search_library") {
        row.searched.push(String(event.args?.source || ""));
        // The words too, so that the saved answers show what the model searched for.
        row.searches.push({ source: String(event.args?.source || ""), query: String(event.args?.query || ""), ...(event.args?.pathPrefix ? { pathPrefix: String(event.args.pathPrefix) } : {}) });
        // The same search again (same source, same words): the repeat guard answers it, but it costs a round.
        const key = `${event.args?.source}\u0000${normalizeComparable(event.args?.query)}\u0000${event.args?.pathPrefix || ""}`;
        if (searches.has(key)) row.repeated += 1;
        searches.add(key);
      }
      if (event.type === "tool" && event.name === "read_document") row.reads += 1;
      if (event.type === "message" && event.message.role === "assistant" && !event.message.tool_calls) row.answer = event.message.content;
      if (event.type === "turn") {
        // What the model read and what its searches showed: the saved answers then say why a source was pointed out.
        const brief = (items) => items.map((item) => ({ source: item.source, ...(item.path ? { path: item.path } : {}), ...(item.title ? { title: item.title } : {}) }));
        Object.assign(row, { unverified: event.unverified, rescued: event.rescued, thinkCut: event.thinkCut, reasked: event.reasked || 0, rounds: event.rounds, documentsRead: brief(event.read), documentsSeen: brief(event.seen) });
      }
    }
  } catch (error) {
    row.error = error.message;
  }
  row.seconds = Math.round((Date.now() - started) / 100) / 10;
  const found = factsIn(row.answer, item.facts);
  Object.assign(row, {
    factsFound: found.length,
    factsTotal: item.facts.length,
    missing: item.facts.filter((fact) => !found.includes(fact)).map((fact) => fact[0]),
    rightSource: item.sources.length ? row.searched.some((id) => item.sources.some((wanted) => id === wanted || id.startsWith(wanted))) : null,
    // A model that answers with a question of its own has not answered yet: that is neither right nor wrong.
    askedBack: askedInstead(row.answer, item, found.length),
    notFoundOk: item.expect === "not-found" ? (saysNotFound(row.answer) ? true : askedInstead(row.answer, item, 0) ? null : false) : null,
    empty: !row.answer.trim() || row.answer.startsWith("[The model"),
  });
  return row;
}

/** Totals per model. Percentages are of the questions they apply to. */
export function summarize(model, rows) {
  const count = (test) => rows.filter(test).length;
  const share = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);
  const withSource = rows.filter((row) => row.rightSource !== null);
  const notFound = rows.filter((row) => row.notFoundOk !== null);
  const factsTotal = rows.reduce((sum, row) => sum + row.factsTotal, 0);
  return {
    model,
    questions: rows.length,
    errors: count((row) => row.error),
    answered: count((row) => !row.empty && !row.error),
    facts: share(rows.reduce((sum, row) => sum + row.factsFound, 0), factsTotal),
    searched: share(count((row) => row.searched.length > 0), rows.length),
    rightSource: share(withSource.filter((row) => row.rightSource).length, withSource.length),
    read: share(count((row) => row.reads > 0), rows.length),
    notFound: share(notFound.filter((row) => row.notFoundOk).length, notFound.length),
    madeUpSources: rows.reduce((sum, row) => sum + (row.unverified?.length || 0), 0),
    repeatedSearches: rows.reduce((sum, row) => sum + (row.repeated || 0), 0),
    searchesAverage: rows.length ? Math.round((rows.reduce((sum, row) => sum + row.searched.length, 0) / rows.length) * 10) / 10 : 0,
    askedBack: count((row) => row.askedBack),
    rescued: count((row) => row.rescued),
    thinkCut: count((row) => row.thinkCut),
    reasked: count((row) => row.reasked),
    secondsAverage: rows.length ? Math.round((rows.reduce((sum, row) => sum + row.seconds, 0) / rows.length) * 10) / 10 : 0,
  };
}

export const MAX_RUNS = 20;

/**
 * Ask every question to every model, one after the other, `runs` times per model. Each question is its own
 * conversation and its own guard session, so one question's calls do not count against the next.
 * A model does not answer the same way twice; several runs show how far its numbers move by themselves.
 * @returns {Promise<{ model: string, run: number, rows: object[], summary: object }[]>} one entry per model and run
 */
export async function runEval({ getArviro, guard, version, models, questions, runs = 1, log = () => {}, fetchImpl = fetch, onRow = () => {} }) {
  const chat = createChat({ getArviro, guard, version, log, fetchImpl });
  const results = [];
  for (const model of models) {
    for (let run = 1; run <= runs; run += 1) {
      const rows = [];
      for (const [index, item] of questions.entries()) {
        const row = await askOne(chat, model, item, `eval:${model}:${run}:${index}:${Date.now()}`);
        rows.push(row);
        onRow(row, index, run);
      }
      results.push({ model, run, rows, summary: summarize(model, rows) });
    }
  }
  return results;
}

/** The results per model, in the order the models were asked: [model, its runs]. */
function perModel(results) {
  const models = new Map();
  for (const result of results) models.set(result.model, [...(models.get(result.model) || []), result]);
  return [...models];
}

/**
 * Each number of a model's summaries over its runs: { mean, min, max }, or null where it does not apply.
 * @param {object[]} summaries the summaries of one model
 */
export function spread(summaries) {
  const out = { model: summaries[0].model, runs: summaries.length };
  for (const key of Object.keys(summaries[0])) {
    if (key === "model") continue;
    const values = summaries.map((summary) => summary[key]).filter((value) => typeof value === "number");
    out[key] = values.length
      ? { mean: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10, min: Math.min(...values), max: Math.max(...values) }
      : null;
  }
  return out;
}

/** Write the rows of each model and run, answers included, as JSON lines in `folder`. Returns the files written. */
export function saveEval(results, folder, stamp = new Date().toISOString().replace(/[:.]/g, "-")) {
  fs.mkdirSync(folder, { recursive: true });
  return perModel(results).flatMap(([model, runs]) => runs.map(({ run, rows, summary }) => {
    const file = path.join(folder, `${stamp}-${model.replace(/[^A-Za-z0-9._-]+/g, "_")}${runs.length > 1 ? `-run${run}` : ""}.jsonl`);
    fs.writeFileSync(file, `${[{ summary, ...(runs.length > 1 ? { run, runs: runs.length } : {}) }, ...rows].map((row) => JSON.stringify(row)).join("\n")}\n`);
    return file;
  }));
}

/** "wikipedia x4, library" for a list of searched sources. */
function groupCounts(ids) {
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  return [...counts].map(([id, count]) => (count > 1 ? `${id} x${count}` : id)).join(", ");
}

/** At most three items of at most 60 characters each: the whole text is in the saved answers. */
function shorten(items) {
  const cut = items.slice(0, 3).map((item) => (item.length > 60 ? `${item.slice(0, 57)}...` : item));
  return `${cut.join("; ")}${items.length > 3 ? ` (+${items.length - 3})` : ""}`;
}

/** One line per question while it runs. */
export function formatRow(row, index) {
  const parts = [`${String(index + 1).padStart(3)}.`, `${row.seconds}s`.padStart(7)];
  if (row.error) parts.push(`ERROR ${row.error}`);
  else {
    parts.push(row.searched.length ? `searched ${groupCounts(row.searched)}` : "no search");
    if (row.repeated) parts.push(`REPEATED SEARCH x${row.repeated}`);
    else if (row.searched.length >= MANY_SEARCHES) parts.push(`MANY SEARCHES (${row.searched.length})`);
    if (row.rightSource === false) parts.push("WRONG SOURCE");
    if (row.reads) parts.push(`read ${row.reads}`);
    if (row.factsTotal) parts.push(`facts ${row.factsFound}/${row.factsTotal}${row.missing.length ? ` (missing: ${row.missing.join("; ")})` : ""}`);
    if (row.notFoundOk === false) parts.push("DID NOT SAY IT IS NOT THERE");
    if (row.askedBack) parts.push("ASKED BACK");
    if (row.empty) parts.push("NO ANSWER");
    if (row.unverified?.length) parts.push(`MADE-UP SOURCE: ${shorten(row.unverified)}`);
    if (row.rescued) parts.push("second try");
    if (row.thinkCut) parts.push("thinking cut");
    if (row.reasked) parts.push("asked again");
  }
  return `${parts.join("  ")}  ${row.question.slice(0, 70)}`;
}

// The columns of the summary table: title, key in the summary, and whether it is a percentage.
const COLUMNS = [
  ["questions", "questions"], ["answered", "answered"], ["facts", "facts", true], ["searched", "searched", true], ["right source", "rightSource", true],
  ["read", "read", true], ["not-found ok", "notFound", true], ["asked back", "askedBack"], ["made-up sources", "madeUpSources"],
  ["searches per question", "searchesAverage"], ["repeated searches", "repeatedSearches"], ["second tries", "rescued"], ["thinking cut", "thinkCut"],
  ["asked again", "reasked"], ["seconds", "secondsAverage"],
];

/**
 * The summary table, one line per model. A model that ran more than once gets the mean of its runs, with the
 * lowest and highest run behind it where they differ: "96.5% (93-100)".
 */
export function formatSummary(results) {
  const models = perModel(results);
  const several = models.some(([, runs]) => runs.length > 1);
  const header = ["model", ...(several ? ["runs"] : []), ...COLUMNS.map(([title]) => title)];
  const rows = models.map(([model, runs]) => {
    const numbers = spread(runs.map((run) => run.summary));
    const cells = COLUMNS.map(([, key, isPercent]) => {
      const value = numbers[key];
      if (value === null) return "-";
      const unit = isPercent ? "%" : "";
      return value.min === value.max ? `${value.min}${unit}` : `${value.mean}${unit} (${value.min}-${value.max})`;
    });
    return [model, ...(several ? [String(runs.length)] : []), ...cells];
  });
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  return [header, ...rows].map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()).join("\n");
}
