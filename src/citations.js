// The source check of the Chat tab: what did the tools show the model, and does the answer name anything else?
// A ledger records every search result and every document read; checkCitations compares the paths and the items
// of a closing "Sources:" line with it. The aim is to point out a source that was never seen, without warning
// about a real source written in the model's own words: a false warning under a right answer costs more trust
// than a missed one. Everything works on splits and string comparisons, so it is linear in the length of the answer.
import { normalizeComparable, STOPWORDS } from "./text.js";

const TOOL_SEARCH = "search_library";
const TOOL_READ = "read_document";
// A sources item longer than this is a sentence about the sources, not a source.
const PROSE_WORDS = 25;
// What a read or a search result showed holds the title the document prints (on its first page, in a page
// header), which can differ from its file name. This much text per result is kept, as rows of three words.
const SHOWN_CHARS = 30_000;
const MAX_SHOWN_PHRASES = 200_000;

/** `text` without the characters of `set` at its start and its end; plain loops, so linear on any input. */
function strip(text, set, { start = true, end = true } = {}) {
  let from = 0;
  let to = text.length;
  if (start) while (from < to && set.includes(text[from])) from += 1;
  if (end) while (to > from && set.includes(text[to - 1])) to -= 1;
  return text.slice(from, to);
}

const normalPath = (value) => {
  let text = strip(strip(String(value || "").trim(), "/", { end: false }), ".:", { start: false });
  try { text = decodeURIComponent(text); } catch {}
  return text.toLowerCase();
};

/**
 * What the tools showed the model: documents it read and search results it saw, each { source, path, title }.
 * Built from the tool calls and results of a conversation, so earlier turns count too.
 */
export function createLedger() {
  const read = new Map();
  const seen = new Map();
  // Per document read: the page numbers and line ranges the reads showed, to check "page 78-79" against.
  const shown = new Map();
  const key = (item) => `${item.source}\u0000${normalPath(item.path)}`;
  const showed = (text) => {
    const row = normalizeComparable(String(text).slice(0, SHOWN_CHARS)).split(" ");
    for (let at = 0; at + 2 < row.length && ledger.phrases.size < MAX_SHOWN_PHRASES; at += 1) ledger.phrases.add(`${row[at]} ${row[at + 1]} ${row[at + 2]}`);
  };
  const ledger = {
    read,
    seen,
    shown,
    sources: new Set(),
    // Sources whose results are places on a map: they have no documents to cite.
    mapSources: new Set(),
    // Every three words in a row of what reads and search results showed, where a document prints its own title.
    phrases: new Set(),
    /** Record one tool call and its result text. */
    record(name, args = {}, text = "") {
      if (args.source) ledger.sources.add(String(args.source));
      const refused = String(text).startsWith(`${name} could not do this`) || String(text).startsWith(`${name} failed`);
      if (name === TOOL_READ && args.source && args.path && !refused) {
        const item = { source: String(args.source), path: String(args.path), title: seen.get(key(args))?.title || null };
        if (!read.has(key(item))) read.set(key(item), item);
        if (!shown.has(key(item))) shown.set(key(item), { pages: new Set(), ranges: [] });
        const positions = shown.get(key(item));
        showed(text);
        for (const line of String(text).split("\n", 400)) {
          if (line.startsWith("page ")) {
            const page = Number(line.slice(5));
            if (Number.isInteger(page)) positions.pages.add(page);
          } else if (line.startsWith("lines: ")) {
            const [first, last] = line.slice(7).split(" ")[0].split("-").map(Number);
            if (Number.isInteger(first) && Number.isInteger(last)) positions.ranges.push([first, last]);
          }
        }
      }
      if (name === TOOL_SEARCH) {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        for (const result of parsed?.results || []) {
          showed(result?.excerpt || result?.snippet || "");
          const where = result?.read;
          if (where?.source && where?.path) {
            const item = { source: String(where.source), path: String(where.path), title: result.title ? String(result.title) : null };
            if (!seen.has(key(item))) seen.set(key(item), item);
          } else if (result?.name) {
            // A map result has no document; its name is what an answer cites.
            const item = { source: String(parsed.source || args.source || "maps"), path: "", title: String(result.name) };
            seen.set(`${item.source}\u0000name:${item.title.toLowerCase()}`, item);
            ledger.mapSources.add(item.source);
          }
        }
      }
    },
    /** Every known document: what was read first, then what was only seen. */
    all: () => [...read.values(), ...ledger.onlySeen()],
    /** What search results showed and no read opened. */
    onlySeen: () => [...seen.values()].filter((item) => !read.has(key(item))),
    /** Whether a read showed this page ("page") or this line ("line"), of any document. */
    showed(number, kind) {
      for (const positions of shown.values()) {
        if (kind === "page" ? positions.pages.has(number) : positions.ranges.some(([first, last]) => number >= first && number <= last)) return true;
      }
      return false;
    },
  };
  return ledger;
}

/** Fill a ledger from the tool calls and results already in a conversation. */
export function ledgerFromHistory(history) {
  const ledger = createLedger();
  let pending = [];
  for (const message of history) {
    if (message.role === "assistant") pending = [...(message.tool_calls || [])];
    else if (message.role === "tool" && pending.length) {
      const call = pending.shift()?.function || {};
      ledger.record(call.name, call.arguments && typeof call.arguments === "object" ? call.arguments : {}, message.content);
    }
  }
  return ledger;
}

const SOURCES_LINE = /^[\s*_#>-]*(?:sources?|bronnen|bron|quellen|quelle)\b[\s*_]*:?/i;
const NONE_ITEM = /^(?:none|geen|keine|aucune?|-)\b/i;
const PIECE_SPLIT = /[\s`"'<>,;]+/;
// How an item begins that is a remark about the sources, not a source: a note, a quotation, a cross-reference.
const REMARKS = [
  "note", "nb", "n b", "let op", "opmerking", "toelichting", "hinweis", "remarque",
  "see also", "see further", "zie ook", "zie verder", "siehe auch", "voir aussi",
  "it says", "it states", "er staat", "hier staat", "daar staat", "quote", "citaat", "zitat",
];

/** A word of an answer without the punctuation around it; brackets stay when they belong to it ("Mercury_(planet)"). */
function trimPiece(raw) {
  const piece = strip(strip(raw, "([*_", { end: false }), ".:!?*_", { start: false });
  const balance = { ")": 0, "]": 0 };
  for (const character of piece) {
    if (character === "(") balance[")"] -= 1;
    else if (character === ")") balance[")"] += 1;
    else if (character === "[") balance["]"] -= 1;
    else if (character === "]") balance["]"] += 1;
  }
  let end = piece.length;
  for (;;) {
    while (end > 0 && ".:!?*_".includes(piece[end - 1])) end -= 1;
    const last = piece[end - 1];
    if ((last === ")" || last === "]") && balance[last] > 0) { balance[last] -= 1; end -= 1; }
    else break;
  }
  return piece.slice(0, end);
}

// Words that say where something is in a document, or what kind of thing it is, not which document it is.
const LINE_WORDS = new Set(["line", "lines", "regel", "regels", "zeile", "zeilen"]);
const POINTER_WORDS = new Set(["pagina", "paginas", "page", "pages", "p", "pp", "blz", "s", "seite", "seiten", ...LINE_WORDS]);
const POINTER_JOINERS = new Set(["en", "and", "tot", "to", "t", "m", "und", "bis", "et", "a"]);
const GENERIC_WORDS = new Set([
  "pdf", "artikel", "artikelen", "article", "articles", "entry", "lemma", "sectie", "section", "hoofdstuk", "chapter", "kapitel",
  "document", "documenten", "documents", "bron", "bronnen", "source", "sources", "quelle", "versie", "edition", "editie",
  "nederlandstalig", "nederlandstalige", "nederlands", "nederlandse", "dutch", "engelstalig", "engelstalige", "engels", "engelse", "english",
  "duits", "duitse", "duitstalig", "german", "deutsch", "deutsche", "frans", "franse", "french", "francais", "francaise",
  "offline", "lokaal", "lokale", "local", "category", "categorie", "region", "regio", "kiwix",
  "library", "bibliotheek", "bibliothek", "bibliotheque",
]);

/**
 * A word in the form names are compared in, so that a model's spelling of a title matches the file name:
 * letters and digits apart ("2025plus" is "2025" and "plus"), numbers without leading zeros ("01" is "1"),
 * and a plural like its singular ("manuals", "handleidingen"). One pass over the word.
 */
function nameParts(word) {
  const parts = [];
  let start = 0;
  const isDigit = (character) => character >= "0" && character <= "9";
  for (let index = 1; index <= word.length; index += 1) {
    if (index < word.length && isDigit(word[index]) === isDigit(word[start])) continue;
    let part = word.slice(start, index);
    if (isDigit(part[0])) {
      let zeros = 0;
      while (zeros < part.length - 1 && part[zeros] === "0") zeros += 1;
      part = part.slice(zeros);
    } else if (part.length >= 6 && part.endsWith("en")) part = part.slice(0, -2);
    else if (part.length >= 4 && part.endsWith("s") && !part.endsWith("ss")) part = part.slice(0, -1);
    parts.push(part);
    start = index;
  }
  return parts;
}

/** The words of a title or file name that say what it is: lowercase, without accents, punctuation and stopwords. */
function contentWords(text) {
  return new Set(normalizeComparable(text).split(" ").filter((word) => word && !STOPWORDS.has(word) && !POINTER_WORDS.has(word) && !GENERIC_WORDS.has(word)).flatMap(nameParts));
}

/** The parts of a text between quotation marks or emphasis ("Gouda", “Making bread”, 'Water', *Bread*). One pass, so linear. */
function quotedParts(text) {
  const closers = { "\"": "\"", "“": "”", "„": "”", "'": "'", "‘": "’", "«": "»", "*": "*" };
  const parts = [];
  let open = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (open === null && closers[character]) { open = closers[character]; start = index + 1; }
    else if (open !== null && character === open) { parts.push(text.slice(start, index)); open = null; }
  }
  return parts;
}

/** The text without what is between brackets: "Pagina 6-7 (Principles of gasification)" becomes "Pagina 6-7 ". */
function withoutBrackets(text) {
  let depth = 0;
  let kept = "";
  for (const character of text) {
    if (character === "(" || character === "[") depth += 1;
    else if ((character === ")" || character === "]") && depth > 0) depth -= 1;
    else if (!depth) kept += character;
  }
  return kept;
}

/**
 * Whether an item only points into a document ("Werking: Pagina 6-7 (Principles of solid fuel gasification)",
 * "regel 12"): a page or line reference and nothing that names a document, besides a short label and brackets.
 */
function isPointer(item) {
  const words = normalizeComparable(withoutBrackets(item)).split(" ").filter(Boolean);
  if (!words.some((word) => POINTER_WORDS.has(word))) return false;
  const colon = item.indexOf(":");
  const label = colon > 0 && colon < 40 ? contentWords(item.slice(0, colon)) : new Set();
  return [...contentWords(withoutBrackets(item))].every((word) => /^\d+$/.test(word) || label.has(word));
}

/** The pages and lines an item points to: the numbers right after "page", "p.", "regel" and the like, as { number, kind }. */
function pointerNumbers(item) {
  const numbers = [];
  let kind = null;
  for (const word of normalizeComparable(item).split(" ")) {
    if (POINTER_WORDS.has(word)) kind = LINE_WORDS.has(word) ? "line" : "page";
    else if (kind && /^\d{1,6}$/.test(word)) numbers.push({ number: Number(word), kind });
    else if (!(kind && POINTER_JOINERS.has(word))) kind = null;
  }
  return numbers;
}

/**
 * What an item may be called by: the whole of it, and its beginning up to the first bracket, comma, colon or dash,
 * since models put details after the name ("Boiler manual (PDF), page 78-79, section ...").
 */
function heads(item) {
  const found = [item];
  for (const mark of ["(", ",", ":", " - ", " – ", " — "]) {
    const at = item.indexOf(mark);
    if (at > 0) found.push(item.slice(0, at));
  }
  return found;
}

/**
 * Whether a sources item names a known document by its words: (nearly) all words of its title or file name are in
 * the item ("WHO Technical Note 05: Emergency treatment of drinking-water (pages 1-2)" for the file
 * who-technical-note-05-emergency-treatment-drinking-water.pdf), or the item is a shortened title of two words or more.
 */
function namesByWords(itemWords, knownNames, sourceWords, pageNumbers) {
  if (!itemWords.size) return false;
  // A number is part of the name ("Technical Note 05"), unless it is a page or line the item points to.
  const extra = (word) => sourceWords.has(word) || (/^\d+$/.test(word) && pageNumbers.has(Number(word)));
  return knownNames.some((names) => {
    let shared = 0;
    for (const word of names) if (itemWords.has(word)) shared += 1;
    if (names.size && shared >= Math.max(1, Math.ceil(names.size * 0.8))) {
      // A title of one or two words fits inside many made-up ones ("Water" in "Water purification handbook"):
      // then the item may add nothing but source names and page numbers.
      if (names.size > 2) return true;
      return [...itemWords].every((word) => names.has(word) || extra(word));
    }
    // A shortened title: two or more of its words, and nothing else but source names and page numbers.
    const meaningful = [...itemWords].filter((word) => !extra(word));
    return meaningful.length >= 2 && meaningful.every((word) => names.has(word));
  });
}

/**
 * The references in an answer that no tool showed the model: paths that were never in a search result or read,
 * and items of a closing "Sources:" line that name no known document, title or source.
 * @param {string} answer
 * @param {object} ledger   from createLedger
 * @param {{ sources?: { id: string, description?: string }[] }} [options]  the sources of the library, so that a source
 *   named by its description ("Dutch Wikipedia", "OpenStreetMap") is recognised
 */
export function checkCitations(answer, ledger, { sources = [] } = {}) {
  // A Markdown link "[text](target)" is its text and its target.
  const text = String(answer || "").replaceAll("](", " ");
  const known = ledger.all();
  const paths = known.filter((item) => item.path).map((item) => normalPath(item.path));
  const titles = known.map((item) => String(item.title || "").toLowerCase()).filter((title) => title.length >= 3);
  // The words of each title and each file name, for an item that cites a document in its own words.
  const knownNames = known.flatMap((item) => [contentWords(item.title || ""), contentWords(String(item.path || "").split("/").at(-1).replace(/\.[a-z0-9]{1,5}$/i, ""))]).filter((names) => names.size);
  const sourceIds = new Set([...ledger.sources, ...known.map((item) => item.source)].map((id) => id.toLowerCase()));
  // What a searched source is called: its id and the words of its description.
  const described = sources.filter((source) => sourceIds.has(String(source.id).toLowerCase()));
  const sourceWords = new Set([...sourceIds, ...described.map((source) => source.description || "")].flatMap((name) => [...contentWords(name), ...normalizeComparable(name).split(" ")]));
  const mapWords = new Set([...ledger.mapSources].flatMap((id) => normalizeComparable(id).split(" ")).concat(ledger.mapSources.size ? ["openstreetmap", "osm"] : []));
  const knownPath = (piece) => {
    let wanted = normalPath(piece);
    // ".../documents/manual.pdf": the model left the beginning out.
    for (const lead of [".../", "…/", "../", "./"]) while (wanted.startsWith(lead)) wanted = wanted.slice(lead.length);
    if (!wanted) return false;
    return paths.some((candidate) => candidate === wanted || candidate.endsWith(`/${wanted}`) || wanted.endsWith(`/${candidate}`));
  };
  const unverified = [];
  const flag = (value) => { if (!unverified.includes(value)) unverified.push(value); };

  // Paths and links: a piece with a slash that looks like a document path or an encyclopedia link.
  for (const raw of text.split(PIECE_SPLIT)) {
    const piece = trimPiece(raw);
    if (!piece.includes("/") || /^[a-z][a-z0-9+.-]*:\/\//i.test(piece)) continue;
    // An extension begins with a letter (".pdf", ".md"; ".7z" and ".3gp" are the exceptions): "3G/3.75G" is not a file.
    const looksLikeDocument = /\.(?:[a-z][a-z0-9]{0,4}|7z|3gp)$/i.test(piece) || piece.startsWith("/kiwix/") || piece.startsWith("kiwix/");
    if (!looksLikeDocument) continue;
    const withoutSource = [...sourceIds].some((id) => piece.toLowerCase().startsWith(`${id}/`)) ? piece.slice(piece.indexOf("/") + 1) : piece;
    if (!knownPath(piece) && !knownPath(withoutSource)) flag(piece);
  }

  // The closing sources line, item by item.
  const lines = text.split("\n");
  const index = lines.findLastIndex((line) => SOURCES_LINE.test(line));
  if (index < 0) return unverified;
  const head = lines[index].replace(SOURCES_LINE, "");
  const items = head.split(/;| \| /).map((item) => item.trim());
  for (const line of lines.slice(index + 1)) {
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) items.push(bullet[1].trim());
    else if (line.trim()) break;
  }
  const titleNamed = (candidate, pageNumbers) => {
    const lower = candidate.trim().toLowerCase();
    // Literally: the same title, a longer title inside it, or it inside a title. Short titles go by their words.
    return titles.some((title) => lower === title || (lower.includes(title) && contentWords(title).size > 2) || (title.includes(lower) && contentWords(lower).size >= 2))
      || namesByWords(contentWords(candidate), knownNames, sourceWords, pageNumbers);
  };
  // The title a document prints, which a read or a search result showed: three words of content or more, word for word.
  const printedTitle = (candidate) => {
    const row = normalizeComparable(candidate).split(" ");
    if (row.length < 3 || contentWords(candidate).size < 3) return false;
    for (let at = 0; at + 2 < row.length; at += 1) if (!ledger.phrases.has(`${row[at]} ${row[at + 1]} ${row[at + 2]}`)) return false;
    return true;
  };
  for (const item of items.map((value) => strip(strip(value, "*_ \t(", { end: false }), "*_. \t", { start: false })).filter(Boolean)) {
    if (NONE_ITEM.test(item)) continue;
    const pieces = item.split(PIECE_SPLIT).map(trimPiece);
    // A path in the item was judged above: known, or already pointed out.
    if (pieces.some((piece) => piece.includes("/") && (knownPath(piece) || unverified.includes(piece)))) continue;
    const plain = normalizeComparable(item);
    const words = plain.split(" ");
    // Not a source at all: a note, a quotation, a cross-reference, or a whole sentence.
    if (REMARKS.some((remark) => plain === remark || plain.startsWith(`${remark} `)) || words.length > PROSE_WORDS) continue;
    const itemWords = contentWords(item);
    const numbers = pointerNumbers(item);
    const pageNumbers = new Set(numbers.map((pointer) => pointer.number));
    const named = heads(item).some((candidate) => titleNamed(candidate, pageNumbers) || printedTitle(candidate))
      // A title in quotation marks or in italics, whatever is around it: Wikipedia (Nederlandstalig), artikel "Gouda".
      || quotedParts(item.replaceAll("**", "*")).map((part) => contentWords(part)).some((quoted) => quoted.size && knownNames.some((names) => names.size === quoted.size && [...quoted].every((word) => names.has(word))))
      // A page or line of a document that was read, written as an item of its own.
      || (ledger.read.size > 0 && isPointer(item))
      // Pages or lines that a read did show: the document, under another name (a translated title).
      || (numbers.length > 0 && numbers.every((pointer) => ledger.showed(pointer.number, pointer.kind)))
      // A map source: there is no document, the model says what it searched for.
      || words.some((word) => mapWords.has(word))
      // Only the source itself, by its id or its description: "Dutch Wikipedia", "library (offline)".
      || (words.some((word) => sourceWords.has(word)) && [...itemWords].every((word) => sourceWords.has(word) || /^\d+$/.test(word)))
      // Nothing that names anything: "the offline library", "local documents".
      || !itemWords.size;
    if (!named) flag(item);
  }
  return unverified;
}
