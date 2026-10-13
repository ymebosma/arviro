// A small Markdown reader for chat answers: paragraphs, headings, lists, code and bold or italic text.
// It returns a tree of plain objects, so the page can build DOM nodes from it (never HTML from model text)
// and a test can check it without a browser. Every step scans forward once, so it stays linear.

const FENCE = "```";

/** Inline parts of one line: strings and { type: "b" | "i" | "code", children }. */
export function parseInline(text, { allowBold = true } = {}) {
  const parts = [];
  let plain = "";
  let position = 0;
  const flush = () => { if (plain) { parts.push(plain); plain = ""; } };
  while (position < text.length) {
    const char = text[position];
    if (char === "`") {
      const end = text.indexOf("`", position + 1);
      if (end > position + 1) { flush(); parts.push({ type: "code", children: [text.slice(position + 1, end)] }); position = end + 1; continue; }
    } else if (allowBold && text.startsWith("**", position)) {
      const end = text.indexOf("**", position + 2);
      if (end > position + 2) { flush(); parts.push({ type: "b", children: parseInline(text.slice(position + 2, end), { allowBold: false }) }); position = end + 2; continue; }
    } else if ((char === "*" || char === "_") && /\S/.test(text[position + 1] || "")) {
      const end = text.indexOf(char, position + 1);
      const before = text[position - 1] || " ";
      if (end > position + 1 && /\S/.test(text[end - 1]) && (char === "*" || !/\w/.test(before))) {
        flush();
        parts.push({ type: "i", children: parseInline(text.slice(position + 1, end), { allowBold }) });
        position = end + 1;
        continue;
      }
    }
    plain += char;
    position += 1;
  }
  flush();
  return parts;
}

/**
 * Blocks of a Markdown text: { type: "p" | "h" | "ul" | "ol" | "pre", level?, children?, items? }.
 * Lines of one paragraph are kept apart with { type: "br" }, as a chat answer often relies on its line breaks.
 */
export function parseMarkdown(text) {
  const blocks = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let paragraph = null;
  let list = null;
  const closeParagraph = () => { if (paragraph) { blocks.push(paragraph); paragraph = null; } };
  const closeList = () => { if (list) { blocks.push(list); list = null; } };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trimStart().startsWith(FENCE)) {
      closeParagraph(); closeList();
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith(FENCE)) { code.push(lines[index]); index += 1; }
      blocks.push({ type: "pre", children: [code.join("\n")] });
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) { closeParagraph(); closeList(); continue; }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { closeParagraph(); closeList(); blocks.push({ type: "h", level: heading[1].length, children: parseInline(heading[2].trim()) }); continue; }
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    const numbered = bullet ? null : trimmed.match(/^\d{1,3}[.)]\s+(.*)$/);
    if (bullet || numbered) {
      closeParagraph();
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) { closeList(); list = { type, items: [] }; }
      list.items.push(parseInline((bullet || numbered)[1]));
      continue;
    }
    closeList();
    if (!paragraph) paragraph = { type: "p", children: [] };
    else paragraph.children.push({ type: "br" });
    paragraph.children.push(...parseInline(trimmed));
  }
  closeParagraph(); closeList();
  return blocks;
}
