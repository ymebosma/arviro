// Text helpers shared by the indexer and the search code.
// Everything here runs on document content, so it must stay fast on any input:
// no pattern may backtrack over an unbounded part of the text.

const STOPWORDS_NL = "aan als bij dat de den der die dit een en er het heb hebt hebben hoe ik in is je kan kun maar met naar niet of om op te tot van voor wat welke wie waarom waar wanneer we wordt worden zijn zich ook mijn onze deze door over onder uit via alle alles goed maak maken handleiding handleidingen veilig veilige informatie geef toont toon zoek vinden vind graag";
const STOPWORDS_EN = "a an and are at be by can could do does for from give have how i in is it me my of on or our please show tell that the their this to we what when where which who why will with you your about find search information guide";
const MAX_LINE_CHARS = 1600;

export const STOPWORDS = new Set(`${STOPWORDS_NL} ${STOPWORDS_EN}`.split(/\s+/));

/** An error caused by the caller's input; its message is safe and useful to show to the model. */
export class UserInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserInputError";
  }
}

/** A problem on the server side (a missing program, an unavailable folder) with a message that is safe to show. */
export class ServiceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ServiceError";
  }
}

/** Lowercase A-Z only, so that positions in the result match positions in the input. */
export function asciiLower(text) {
  return String(text).replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalizeComparable(value) {
  return String(value || "")
    .toLocaleLowerCase("nl")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Distinct search tokens of a question, without stopwords (at most 12). */
export function tokensFor(query) {
  const words = String(query || "").toLocaleLowerCase("nl").normalize("NFKD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) || [];
  return [...new Set(words)].filter((token) => token.length >= 2 && !STOPWORDS.has(token)).slice(0, 12);
}

/** FTS5 query matching any token as a prefix, or null when the question has no usable words. */
export function ftsQuery(query) {
  const tokens = tokensFor(query).map((token) => `"${token.replace(/"/g, '""')}"*`);
  return tokens.length ? tokens.join(" OR ") : null;
}

function codePoint(code, original) {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : original;
}

export function decodeEntities(input) {
  return String(input)
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&#(\d{1,8});/g, (match, digits) => codePoint(Number(digits), match))
    .replace(/&#x([0-9a-f]{1,6});/gi, (match, hex) => codePoint(Number.parseInt(hex, 16), match))
    .replace(/&amp;/gi, "&");
}

/** Text between `<name ...>` and `</name>`, or null. Used instead of a regular expression to stay linear. */
export function elementText(html, name) {
  const lower = asciiLower(html);
  let start = lower.indexOf(`<${name}`);
  while (start >= 0 && /[a-z0-9]/.test(lower[start + name.length + 1] || "")) start = lower.indexOf(`<${name}`, start + 1);
  if (start < 0) return null;
  const open = lower.indexOf(">", start);
  if (open < 0) return null;
  const end = lower.indexOf(`</${name}`, open);
  return html.slice(open + 1, end < 0 ? html.length : end);
}

/** Remove every `<name ...> ... </name>` block; an unclosed block is removed up to the end. */
function removeElements(html, name) {
  const lower = asciiLower(html);
  const open = `<${name}`;
  const close = `</${name}`;
  let result = "";
  let position = 0;
  while (position < html.length) {
    let start = lower.indexOf(open, position);
    while (start >= 0 && /[a-z0-9]/.test(lower[start + open.length] || "")) start = lower.indexOf(open, start + 1);
    if (start < 0) return result + html.slice(position);
    result += `${html.slice(position, start)} `;
    const end = lower.indexOf(close, start);
    if (end < 0) return result;
    const after = lower.indexOf(">", end);
    position = after < 0 ? html.length : after + 1;
  }
  return result;
}

/** Plain text of an HTML document. Block elements start a new line. */
export function htmlToText(input) {
  const withoutCode = removeElements(removeElements(String(input), "script"), "style");
  return decodeEntities(withoutCode
    .replace(/<\/?(?:p|div|section|article|main|header|footer|h[1-6]|li|tr|table|br|hr)\b[^<>]*>/gi, "\n")
    .replace(/<[^<>]*>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
}

export function stripTags(value) {
  return htmlToText(value).replace(/\s+/g, " ").trim();
}

/** Remove the padding that layout-preserving PDF extraction leaves: trailing spaces and long runs of spaces. */
export function squeezeSpaces(text) {
  // Long runs are shortened first, which keeps the end-of-line pattern fast on any input.
  return String(text).replace(/[ \t]{3,}/g, "  ").replace(/[ \t]+$/gm, "");
}

/** Title of a text document: its first Markdown heading, else the file name. */
export function titleFromText(fileName, text) {
  const heading = text.match(/^[ \t]*#[ \t]+(.+)$/m)?.[1]?.trim();
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return (heading || base.replace(/[-_]+/g, " ")).slice(0, 240);
}

/** Split text into overlapping passages of roughly `maxChars`, keeping line numbers. */
export function chunksFromLines(text, maxChars = 1500, overlapLines = 3) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    while (start < lines.length && !lines[start].trim()) start += 1;
    if (start >= lines.length) break;
    let end = start;
    let size = 0;
    while (end < lines.length && (size < maxChars || end === start)) {
      size += lines[end].length + 1;
      end += 1;
      if (size >= maxChars && !lines[end - 1]?.trim()) break;
    }
    const content = lines.slice(start, end).join("\n").trim();
    if (content.length >= 30) chunks.push({ content, lineStart: start + 1, lineEnd: end });
    if (end >= lines.length) break; // the overlap must not produce extra passages of only the last lines
    start = Math.max(start + 1, end - overlapLines);
  }
  return chunks;
}

/** Passages per page, for text whose pages are separated by form feeds (pdftotext output). */
export function chunksFromPages(text) {
  const result = [];
  for (const [pageIndex, pageText] of text.split("\f").entries()) {
    for (const chunk of chunksFromLines(pageText)) result.push({ ...chunk, page: pageIndex + 1, lineStart: null, lineEnd: null });
  }
  return result;
}

/**
 * The subject of a "who is X?" style question, or of a bare proper name.
 * Returns null for ordinary questions.
 */
export function extractEntityLookup(query) {
  const value = String(query || "").trim();
  const patterns = [
    /^(?:ken(?:t|nen)?\s+(?:je|jij|u)|wie\s+is|wat\s+weet\s+(?:je|jij|u)\s+over|vertel(?:\s+(?:me|mij))?\s+(?:iets\s+)?over)\s+(.+?)\s*[?!.]*$/iu,
    /^(?:who\s+is|do\s+you\s+know|what\s+do\s+you\s+know\s+about|tell\s+me\s+about)\s+(.+?)\s*[?!.]*$/iu,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const subject = match[1].replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
    const words = subject.match(/[\p{L}\p{N}'’-]+/gu) || [];
    if (subject.length >= 2 && subject.length <= 120 && words.length <= 10) return subject;
  }
  const bareName = value.replace(/[?!.]+$/g, "").trim();
  if (/^\p{Lu}[\p{L}\p{M}'’-]{1,}(?:\s+\p{Lu}[\p{L}\p{M}'’-]{1,}){1,5}$/u.test(bareName)) return bareName;
  return null;
}

// A word boundary that also works for letters outside ASCII, which \b does not.
const WORD_START = "(?<![\\p{L}\\p{M}\\p{N}])";

/** Capitalised words of three or more letters ("België", "Kobel"). */
export function properNames(query) {
  return String(query || "").match(new RegExp(`${WORD_START}\\p{Lu}[\\p{L}\\p{M}'’-]{2,}`, "gu")) || [];
}

/** Runs of capitalised words ("Gregor Kobel"), longest first. */
export function properNamePhrases(query) {
  const pattern = new RegExp(`${WORD_START}\\p{Lu}[\\p{L}\\p{M}'’-]{1,}(?:\\s+\\p{Lu}[\\p{L}\\p{M}'’-]{1,})+`, "gu");
  const matches = String(query || "").match(pattern) || [];
  return [...new Set(matches.map((value) => value.trim()))].sort((a, b) => b.length - a.length);
}

export function levenshtein(left, right) {
  const a = [...normalizeComparable(left)];
  const b = [...normalizeComparable(right)];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** One numbered output line; a very long line is cut, and says so. */
export function numberedRow(label, line) {
  if (line.length <= MAX_LINE_CHARS) return `${label}: ${line}`;
  return `${label}: ${line.slice(0, MAX_LINE_CHARS)} [line cut, ${line.length - MAX_LINE_CHARS} more characters]`;
}

/**
 * Number the lines from `offset` on, stopping at `limit` lines or `maxChars` characters.
 * @returns {{ rows: string[], first: number, last: number, next: number|null }}  `next` is the offset to continue from
 */
export function numberedLines(lines, offset, limit, maxChars) {
  const rows = [];
  let used = 0;
  let index = offset - 1;
  const end = Math.min(lines.length, offset - 1 + limit);
  for (; index < end; index += 1) {
    const row = numberedRow(index + 1, lines[index]);
    if (rows.length && used + row.length > maxChars) break;
    rows.push(row);
    used += row.length + 1;
  }
  return { rows, first: Math.min(offset, lines.length), last: index, next: index < lines.length ? index + 1 : null };
}

/** Validate a relative folder filter. Returns "" for no filter; throws on unsafe input. */
export function normalizePathPrefix(value) {
  const prefix = String(value || "").trim().replace(/^\/+|\/+$/gu, "");
  if (!prefix) return "";
  if (prefix.length > 240 || prefix.includes("..") || !/^[\p{L}\p{N}._ /&'()-]+$/u.test(prefix)) {
    throw new UserInputError("Invalid pathPrefix: use a relative folder path from a search result, without \"..\".");
  }
  return prefix;
}
