import assert from "node:assert/strict";
import test from "node:test";
import { parseInline, parseMarkdown } from "../src/ui/markdown.js";

test("inline markup: bold, italic and code, with plain text otherwise", () => {
  assert.deepEqual(parseInline("The **Pharmacy Neumann** at *0.28 km*, see `maps`."), [
    "The ", { type: "b", children: ["Pharmacy Neumann"] }, " at ", { type: "i", children: ["0.28 km"] }, ", see ", { type: "code", children: ["maps"] }, ".",
  ]);
  assert.deepEqual(parseInline("2 * 3 * 4 and snake_case_name and a lone ** here"), ["2 * 3 * 4 and snake_case_name and a lone ** here"]);
  assert.deepEqual(parseInline("**bold with `code`**"), [{ type: "b", children: ["bold with ", { type: "code", children: ["code"] }] }]);
  assert.deepEqual(parseInline("_emphasis_ at the start"), [{ type: "i", children: ["emphasis"] }, " at the start"]);
});

test("blocks: paragraphs with line breaks, headings, lists and fenced code", () => {
  const blocks = parseMarkdown("## Result\n\nFirst line\nsecond line\n\n- one\n- **two**\n\n1. first\n2) second\n\n```\nraw *text*\n```\n");
  assert.deepEqual(blocks.map((block) => block.type), ["h", "p", "ul", "ol", "pre"]);
  assert.equal(blocks[0].level, 2);
  assert.deepEqual(blocks[1].children, ["First line", { type: "br" }, "second line"]);
  assert.deepEqual(blocks[2].items, [["one"], [{ type: "b", children: ["two"] }]]);
  assert.deepEqual(blocks[3].items, [["first"], ["second"]]);
  assert.deepEqual(blocks[4].children, ["raw *text*"]);
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("```\nunclosed"), [{ type: "pre", children: ["unclosed"] }]);
});

test("a long answer with many markers is handled in linear time", () => {
  const text = `${"**".repeat(20_000)}\n${"`".repeat(20_000)}\n${"* ".repeat(20_000)}`;
  const started = performance.now();
  parseMarkdown(text);
  assert.ok(performance.now() - started < 500);
});
