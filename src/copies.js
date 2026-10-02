// A PDF may come with a text copy that is used in its place: "report.txt" next to "report.pdf",
// or in a "tekst"/"text" folder next to the "documenten"/"documents" folder that holds the PDF.
// The copy is expected to have a form feed between pages, the way pdftotext writes it.
import fs from "node:fs";
import path from "node:path";

const TEXT_DIRS = ["tekst", "text"];
const DOCUMENT_DIRS = ["documenten", "documents"];

/** The text copy of a PDF, or null. */
export function textCopyOf(pdfFile) {
  const directory = path.dirname(pdfFile);
  const base = path.basename(pdfFile, path.extname(pdfFile));
  const candidates = [path.join(directory, `${base}.txt`)];
  if (DOCUMENT_DIRS.includes(path.basename(directory))) {
    for (const name of TEXT_DIRS) candidates.push(path.join(path.dirname(directory), name, `${base}.txt`));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/** The PDF that a text file is the copy of, or null. */
export function pdfOfTextCopy(textFile) {
  const directory = path.dirname(textFile);
  const base = path.basename(textFile, path.extname(textFile));
  const candidates = [path.join(directory, `${base}.pdf`)];
  if (TEXT_DIRS.includes(path.basename(directory))) {
    for (const name of DOCUMENT_DIRS) candidates.push(path.join(path.dirname(directory), name, `${base}.pdf`));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}
