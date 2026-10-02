// Bounded, read-only access to the files of a document source.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { textCopyOf } from "./copies.js";
import { TOOL_SEARCH } from "./names.js";
import { htmlToText, numberedLines, numberedRow, ServiceError, squeezeSpaces, UserInputError } from "./text.js";

const execFileAsync = promisify(execFile);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".csv", ".tsv", ".json", ".html"]);
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const PDF_PAGES_PER_READ = 3;
export const DEFAULT_MAX_READ_CHARS = 12_000;

function realPathOrNull(target) {
  try { return fs.realpathSync(target); } catch { return null; }
}

function isInside(parent, child) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

/**
 * Whether a file belongs to what the source offers: inside its folder, and not hidden, excluded
 * or part of another source that lies inside this one. `real` must be a resolved path.
 */
export function isServed(source, rootReal, real) {
  if (real === rootReal || !isInside(rootReal, real)) return false;
  const segments = path.relative(rootReal, real).split(path.sep);
  if (segments.some((segment) => segment.startsWith(".") || source.exclude.has(segment))) return false;
  return !source.nested.some((nestedRoot) => {
    const nestedReal = realPathOrNull(nestedRoot);
    return nestedReal !== null && isInside(nestedReal, real);
  });
}

/**
 * Resolve a relative path of a search result to a file of the source.
 * Symbolic links are followed first, so a link cannot lead to a place the source does not offer.
 */
export function resolveInside(source, requested) {
  const rootReal = realPathOrNull(source.root);
  if (!rootReal) throw new ServiceError("The folder of this source is not available right now.");
  const hint = `Use a relative path returned by ${TOOL_SEARCH}.`;
  const relative = String(requested || "").replace(/^\/+/, "");
  if (!relative || relative.split(/[\\/]/).some((part) => part.startsWith("."))) throw new UserInputError(hint);
  const candidate = path.resolve(rootReal, relative);
  if (!isInside(rootReal, candidate) || candidate === rootReal) throw new UserInputError(`The path is outside this source. ${hint}`);
  const real = realPathOrNull(candidate);
  if (!real) throw new UserInputError(`This file does not exist. ${hint}`);
  if (!isServed(source, rootReal, real)) throw new UserInputError(`This path is not part of this source. ${hint}`);
  return { rootReal, real };
}

/**
 * Text of a PDF, pages separated by form feeds. A page range beyond the last page gives "".
 * @throws {ServiceError} with a message that does not contain file paths
 */
export async function pdfToText(pdftotext, file, { firstPage = null, lastPage = null } = {}) {
  if (!pdftotext) throw new ServiceError("PDF files cannot be read: pdftotext is not installed.");
  const range = firstPage ? ["-f", String(firstPage), "-l", String(lastPage || firstPage)] : [];
  try {
    const { stdout } = await execFileAsync(pdftotext, [...range, "-layout", file, "-"], { encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
    return String(stdout || "");
  } catch (error) {
    if (firstPage && /wrong page range|after the last page/i.test(String(error.stderr || ""))) return "";
    throw new ServiceError("This PDF could not be converted to text.", { cause: error });
  }
}

/** The pages `first` up to and including `last` of a PDF, from its text copy when it has one. */
async function pdfPages(source, rootReal, real, first, last, pdftotext) {
  const copy = textCopyOf(real);
  const copyReal = copy && realPathOrNull(copy);
  if (copyReal && isServed(source, rootReal, copyReal) && fs.statSync(copyReal).size <= MAX_TEXT_BYTES) {
    const text = fs.readFileSync(copyReal, "utf8");
    if (text.includes("\f")) return text.split("\f").slice(first - 1, last);
  }
  const pages = (await pdfToText(pdftotext, real, { firstPage: first, lastPage: last })).split("\f");
  if (!pages.at(-1).trim()) pages.pop(); // pdftotext ends every page with a form feed
  return pages;
}

/**
 * Read part of a document as numbered lines.
 * For a PDF, `offset` is a page number and up to three pages are returned; otherwise it is a line number.
 * The result never exceeds `limit` lines or (roughly) `maxChars` characters, and says how to continue.
 */
export async function readDocument(source, requestedPath, { offset = 1, limit = 120, maxChars = DEFAULT_MAX_READ_CHARS, pdftotext = null } = {}) {
  let target;
  try {
    target = resolveInside(source, requestedPath);
  } catch (error) {
    // Tolerate "sourceid/path", the way documents are often cited.
    const prefix = `${source.id}/`;
    if (!(error instanceof UserInputError) || !String(requestedPath).startsWith(prefix)) throw error;
    target = resolveInside(source, String(requestedPath).slice(prefix.length));
  }
  const { rootReal, real } = target;
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new UserInputError("This path is a folder, not a document.");
  const relative = path.relative(rootReal, real).split(path.sep).join("/");
  const extension = path.extname(real).toLowerCase();
  const output = [`source: ${source.id}`, `path: ${relative}`];

  if (extension === ".pdf") {
    if (stat.size > MAX_PDF_BYTES) throw new UserInputError("This PDF is too large to read.");
    // One page more than is shown, to know whether the document continues.
    const pages = await pdfPages(source, rootReal, real, offset, offset + PDF_PAGES_PER_READ, pdftotext);
    let emitted = 0;
    let used = 0;
    let cut = null;
    let lastPage = offset - 1;
    for (const [pageIndex, pageText] of pages.slice(0, PDF_PAGES_PER_READ).entries()) {
      const pageNumber = offset + pageIndex;
      // A further page is only started when there is room for it.
      if (emitted && (emitted >= limit || used + pageText.length > maxChars)) break;
      lastPage = pageNumber;
      // Layout padding and blank lines would use up the budget without adding content.
      const pageLines = squeezeSpaces(pageText).split("\n").filter((line) => line.trim());
      if (!pageLines.length) continue;
      output.push(`page ${pageNumber}`);
      for (const [lineIndex, line] of pageLines.entries()) {
        const row = numberedRow(`${pageNumber}.${lineIndex + 1}`, line);
        if (emitted >= limit || (emitted && used + row.length > maxChars)) { cut = pageNumber; break; }
        output.push(row);
        emitted += 1;
        used += row.length + 1;
      }
      if (cut) break;
    }
    const further = pages.slice(lastPage - offset + 1).some((pageText) => pageText.trim());
    if (!emitted && further) output.push(`No text on pages ${offset}-${lastPage}; the next page is offset ${lastPage + 1}`);
    else if (!emitted) output.push(`No text at page ${offset}; the document may have fewer pages.`);
    else if (cut) output.push(`truncated: page ${cut} was cut off here; the next page is offset ${cut + 1}`);
    else if (further) output.push(`more: the next page is offset ${lastPage + 1}`);
    return { text: output.join("\n"), path: relative, kind: "pdf", page: offset };
  }

  if (!TEXT_EXTENSIONS.has(extension)) throw new UserInputError("This file type cannot be read. Readable types: PDF, Markdown, text, CSV, TSV, JSON and HTML.");
  if (stat.size > MAX_TEXT_BYTES) throw new UserInputError("This file is too large to read.");
  let content = fs.readFileSync(real, "utf8").replace(/\u0000/g, "");
  if (extension === ".html") content = htmlToText(content);
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const part = numberedLines(lines, offset, limit, maxChars);
  if (!part.rows.length) output.push(`No lines at offset ${offset}; the document has ${lines.length} lines.`);
  else output.push(`lines: ${part.first}-${part.last} of ${lines.length}`, ...part.rows);
  if (part.rows.length && part.next) output.push(`more: continue with offset ${part.next}`);
  return { text: output.join("\n"), path: relative, kind: extension.slice(1), totalLines: lines.length };
}
