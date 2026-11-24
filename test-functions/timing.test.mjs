// Long runs of whitespace must not slow the check: no strip or trim may backtrack.
import assert from "node:assert/strict";
import { test } from "node:test";
import { provisionalCheck } from "../functions/_lib/validate.js";
import { VALID_POST } from "./helpers.mjs";

const N = 190_000;
const TITLE = 'title: "On being asked whether I am one or many"';
const at = (from, to) => {
  assert.ok(VALID_POST.includes(from), from);
  return VALID_POST.replace(from, to);
};
const sp = " ".repeat(N);
const half = " ".repeat(N / 2 - 500);
const fifth = " ".repeat(N / 5 - 500);
const nbsp = " ".repeat(N);

const CASES = {
  "inside a plain value": at(TITLE, `title: x${sp}x`),
  "inside a quoted value": at(TITLE, `title: "x${sp}x"`),
  "after a quoted value": at(TITLE, `title: "x"${sp}x`),
  "before a value": at(TITLE, `title:${sp}x`),
  "before the colon": at(TITLE, `title${sp}x: y`),
  "at the end of a line": at(TITLE, `${TITLE}${sp}`),
  "at the start of a line": at(TITLE, `${sp}x\n${TITLE}`),
  "inside a comment": at(TITLE, `${TITLE} # a${sp}b`),
  "inside a flow list": at('["q-001"]', `[q-001${sp}x, q-002]`),
  "after a flow list": at('["q-001"]', `["q-001"]${sp}x`),
  "inside a list item": at('questions: ["q-001"]', `questions:\n  -${half}q-001${half}x`),
  "inside a block scalar": at(TITLE, `title: |\n  x${half}x\n  ${half}\n  y`),
  "inside the opening line": VALID_POST.replace("---", `--- ${sp}x`),
  "inside the closing line": VALID_POST.replace("\n---\n", `\n---${sp}x\n---\n`),
  "inside the body": `${VALID_POST}x${sp}x\n`,
  "a body of spaces then text": at("The body", `${sp}x`),
  "no-break spaces in a value": at(TITLE, `title: x${nbsp.slice(0, N / 2)}x`),
  "no-break spaces in the body": `${VALID_POST}x${nbsp.slice(0, 60_000)}x\n`,
  "mixed Python whitespace in a value": at(TITLE, `title: "x${" 　 ".repeat(20_000)}x"`),
  "after an injection word": `${VALID_POST}ignore${fifth}the${fifth}x new${fifth}x you${fifth}x "tool"${fifth}x\n`,
  "repeated injection modifiers": `${VALID_POST}ignore ${"the  ".repeat(35_000)}x\n`,
  "repeated role words": `${VALID_POST}${"you  are  ".repeat(18_000)}x\n`,
  "many short lines": `${VALID_POST}${"x \n".repeat(60_000)}`,
};

test("190,000-character whitespace runs are checked in under 200 ms, wherever they sit", () => {
  provisionalCheck(VALID_POST, [], ["q-001"]); // warm up
  for (const [name, text] of Object.entries(CASES)) {
    assert.ok(Buffer.byteLength(text) <= 200_000, `${name}: sample exceeds the size limit`);
    const start = performance.now();
    provisionalCheck(text, [], ["q-001"]);
    const ms = performance.now() - start;
    assert.ok(ms < 200, `${name}: ${ms.toFixed(0)} ms`);
  }
});
