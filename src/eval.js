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
const ABOUT_FINDING = new Set([
  "find", "found", "know", "tell", "contain", "contains", "have", "has", "available", "access", "information", "library", "source", "sources", "documents", "records", "data", "mentioned", "listed", "included",
  "vinden", "gevonden", "vind", "weet", "weten", "vertellen", "zeggen", "bevat", "bevatten", "heb", "hebben", "beschikbaar", "toegang", "informatie", "gegevens", "bibliotheek", "bron", "bronnen", "documenten", "opgenomen", "vermeld", "staat", "staan", "terug",
  "finden", "gefunden", "weiss", "enthalten", "informationen", "bibliothek", "quelle", "trouve", "trouver", "information", "bibliotheque",
]);
const NEEDS_T = new Set(["can", "don", "doesn", "isn", "couldn"]);
const NEARBY = 6;

/** Whether an answer says the library does not have it: a denial within a few words of a word about finding or having. */
export function saysNotFound(answer) {
  const text = normalizeComparable(answer);
  if (NOT_FOUND_PHRASES.some((phrase) => text.includes(phrase))) return true;
  const words = text.split(" ");
  let lastDenial = -Infinity;
  let lastFinding = -Infinity;
  for (const [index, word] of words.entries()) {
    // "can", "don" and the like only deny with the "t" of their contraction ("can't" becomes "can t").
    const denial = DENIALS.has(word) && (!NEEDS_T.has(word) || words[index + 1] === "t");
    if (denial) lastDenial = index;
    if (ABOUT_FINDING.has(word)) lastFinding = index;
    if ((denial || ABOUT_FINDING.has(word)) && Math.abs(lastDenial - lastFinding) <= NEARBY) return true;
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
      if (event.type === "turn") Object.assign(row, { unverified: event.unverified, rescued: event.rescued, thinkCut: event.thinkCut, rounds: event.rounds });
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
    askedBack: asksBack(row.answer),
    notFoundOk: item.expect === "not-found" ? (saysNotFound(row.answer) ? true : asksBack(row.answer) ? null : false) : null,
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
    secondsAverage: rows.length ? Math.round((rows.reduce((sum, row) => sum + row.seconds, 0) / rows.length) * 10) / 10 : 0,
  };
}

/**
 * Ask every question to every model, one after the other. Each question is its own conversation and its own
 * guard session, so one question's calls do not count against the next.
 * @returns {Promise<{ model: string, rows: object[], summary: object }[]>}
 */
export async function runEval({ getArviro, guard, version, models, questions, log = () => {}, fetchImpl = fetch, onRow = () => {} }) {
  const chat = createChat({ getArviro, guard, version, log, fetchImpl });
  const results = [];
  for (const model of models) {
    const rows = [];
    for (const [index, item] of questions.entries()) {
      const row = await askOne(chat, model, item, `eval:${model}:${index}:${Date.now()}`);
      rows.push(row);
      onRow(row, index);
    }
    results.push({ model, rows, summary: summarize(model, rows) });
  }
  return results;
}

/** Write each model's rows, answers included, as JSON lines in `folder`. Returns the files written. */
export function saveEval(results, folder, stamp = new Date().toISOString().replace(/[:.]/g, "-")) {
  fs.mkdirSync(folder, { recursive: true });
  return results.map(({ model, rows, summary }) => {
    const file = path.join(folder, `${stamp}-${model.replace(/[^A-Za-z0-9._-]+/g, "_")}.jsonl`);
    fs.writeFileSync(file, `${[{ summary }, ...rows].map((row) => JSON.stringify(row)).join("\n")}\n`);
    return file;
  });
}

const percent = (value) => (value === null ? "-" : `${value}%`);

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
  }
  return `${parts.join("  ")}  ${row.question.slice(0, 70)}`;
}

/** The summary table, one line per model. */
export function formatSummary(results) {
  const header = ["model", "questions", "answered", "facts", "searched", "right source", "read", "not-found ok", "asked back", "made-up sources", "searches per question", "repeated searches", "second tries", "thinking cut", "seconds"];
  const rows = results.map(({ summary: s }) => [s.model, s.questions, s.answered, percent(s.facts), percent(s.searched), percent(s.rightSource), percent(s.read), percent(s.notFound), s.askedBack, s.madeUpSources, s.searchesAverage, s.repeatedSearches, s.rescued, s.thinkCut, s.secondsAverage].map(String));
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  return [header, ...rows].map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()).join("\n");
}
