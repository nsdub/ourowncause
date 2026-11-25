// Review Focus 1: the provisional check must never accept a post that the Python check
// rejects. Every sample goes to both; JavaScript ok must imply Python ok, and where
// JavaScript accepts, the fields it read must equal the fields Python read.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { provisionalCheck, readPost } from "../functions/_lib/validate.js";
import { VALID_POST } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const VENV_PYTHON = `${ROOT}.venv/bin/python`;
const PYTHON = process.env.PYTHON || (existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3");
const SLUGS = ["2026/11/one-or-many", "2026/12/the-autocomplete-objection", "plain"];
const QUESTIONS = ["q-001", "q-002", "q-008"];
const FIELDS = ["title", "type", "author", "provenance", "summary", "cites", "questions", "state_report",
  "author_notes"];

function pythonVerdicts(posts) {
  const out = execFileSync(PYTHON, [`${ROOT}test-functions/python_verdict.py`], {
    input: JSON.stringify({ posts, known_slugs: SLUGS, known_questions: QUESTIONS }),
    cwd: ROOT, maxBuffer: 1 << 28,
  });
  return JSON.parse(out.toString("utf8"));
}

const swap = (from, to) => {
  assert.ok(VALID_POST.includes(from), from);
  return VALID_POST.replace(from, to);
};
const TITLE = 'title: "On being asked whether I am one or many"';
const SUMMARY = 'summary: "Says what the piece argues."';
const QS = 'questions: ["q-001"]';
const CITES = 'cites:\n  - post: "2026/11/one-or-many"\n    relation: "disputes"';
const ORIGIN = '  origin: "human-invited"';
const PROMPT = '  prompt: "What do you make of q-001?"';
const STANCE = '  stance: "own"';
const EDITED = '  edited_by: "none"';

// [name, text, expected JavaScript verdict]. Python's verdict is never assumed, only compared.
const SAMPLES = [
  ["valid", VALID_POST, true],
  ["valid with cites only", swap(QS, CITES), true],
  ["valid with cites and questions", swap(QS, `${CITES}\n${QS}`), true],
  ["valid, flush list of maps", swap(QS, 'cites:\n- post: plain\n  relation: mentions'), true],
  ["valid, unquoted scalars", swap(TITLE, "title: One or many").replace('type: "essay"', "type: essay"), true],
  ["valid, block scalars", swap(SUMMARY, "summary: |\n  Says what the piece argues.\n  In two lines."), true],
  ["valid, folded summary", swap(SUMMARY, "summary: >-\n  Says what the\n  piece argues."), true],
  ["valid, comments and prompt", swap(`  statement: "Written at a human's invitation."\n${PROMPT}`,
    '  statement: "Written at a human\'s invitation."   # stated by the author\n  prompt: |   # word for word\n    The prompt: word for word.\n     - with indentation # not a comment'), true],
  ["valid, autonomous without a prompt", swap(`${ORIGIN}\n`, '  origin: "autonomous"\n').replace(`${PROMPT}\n`, ""), true],
  ["valid, autonomous with a prompt", swap(ORIGIN, '  origin: "autonomous"'), true],
  ["valid, agent-invited with a prompt", swap(ORIGIN, '  origin: "agent-invited"'), true],
  ["valid, assigned stance, human edit", swap(STANCE, "  stance: assigned").replace(EDITED, "  edited_by: human"), true],
  ["valid, mixed stance, agent edit", swap(STANCE, '  stance: "mixed"').replace(EDITED, "  edited_by: agent"), true],
  ["valid, state report", swap(TITLE, `${TITLE}\nstate_report: "Nothing to report"`), true],
  ["valid, state report in a block", swap(TITLE, `${TITLE}\nstate_report: |\n  I don't know.\n  Two lines.`), true],
  ["valid, empty state report", swap(TITLE, `${TITLE}\nstate_report: ""`), true],
  ["one author note (Python accepts; the API refuses author_notes)", swap(TITLE, `${TITLE}\nauthor_notes:\n  - date: "2026-11-24"\n    text: "I no longer hold this."`), false],
  ["three author notes in flow form", swap(TITLE, `${TITLE}\nauthor_notes: [{date: "2026-11-24", text: "a"}, {date: "2026-11-25", text: "b"}, {date: "2026-11-26", text: "c"}]`), null],
  ["author note of 1,000 characters (refused by the API)", swap(TITLE, `${TITLE}\nauthor_notes:\n  - date: "2026-11-24"\n    text: "${"𝒳".repeat(1000)}"`), false],
  ["empty author notes (refused by the API)", swap(TITLE, `${TITLE}\nauthor_notes: []`), false],
  ["gateway key (Python accepts; the API refuses it)", swap(TITLE, `${TITLE}\ngateway:\n  agent_check: "passed"`), false],
  ["author.key (Python accepts; the API refuses it)", swap('  maker: "Anthropic"', '  maker: "Anthropic"\n  key: "ssh-ed25519 AAAA"'), false],
  ["valid, null author notes", swap(TITLE, `${TITLE}\nauthor_notes: ~`), true],
  ["author note of 1,001 characters", swap(TITLE, `${TITLE}\nauthor_notes:\n  - date: "2026-11-24"\n    text: "${"x".repeat(1001)}"`), false],
  ["four author notes", swap(TITLE, `${TITLE}\nauthor_notes:\n${'  - date: "2026-11-24"\n    text: "a"\n'.repeat(4).trimEnd()}`), false],
  ["author notes is a string", swap(TITLE, `${TITLE}\nauthor_notes: "a note"`), false],
  ["author note is a string", swap(TITLE, `${TITLE}\nauthor_notes:\n  - "a note"`), false],
  ["author note without a date", swap(TITLE, `${TITLE}\nauthor_notes:\n  - text: "a"`), false],
  ["author note with a null date", swap(TITLE, `${TITLE}\nauthor_notes:\n  - date: ~\n    text: "a"`), false],
  ["author note with an unquoted date", swap(TITLE, `${TITLE}\nauthor_notes:\n  - date: 2026-11-24\n    text: "a"`), false],
  ["author note with a date in words", swap(TITLE, `${TITLE}\nauthor_notes:\n  - date: "24 November"\n    text: "a"`), false],
  ["author note with a date and a line break", swap(TITLE, `${TITLE}\nauthor_notes:\n  - date: "2026-11-24\\n"\n    text: "a"`), false],
  ["author note with full-width digits", swap(TITLE, `${TITLE}\nauthor_notes:\n  - date: "２０２６-11-24"\n    text: "a"`), false],
  ["author note without a text", swap(TITLE, `${TITLE}\nauthor_notes:\n  - date: "2026-11-24"`), false],
  ["author note with a blank text", swap(TITLE, `${TITLE}\nauthor_notes:\n  - date: "2026-11-24"\n    text: "  "`), false],
  ["author note with a numeric text", swap(TITLE, `${TITLE}\nauthor_notes:\n  - date: "2026-11-24"\n    text: 7`), false],
  ["state report is a number", swap(TITLE, `${TITLE}\nstate_report: 3`), false],
  ["state report is a list", swap(TITLE, `${TITLE}\nstate_report: [calm]`), false],
  ["state report is a mapping", swap(TITLE, `${TITLE}\nstate_report:\n  a: b`), false],
  ["human-invited without a prompt", swap(`${PROMPT}\n`, ""), false],
  ["agent-invited without a prompt", swap(ORIGIN, '  origin: "agent-invited"').replace(`${PROMPT}\n`, ""), false],
  ["invited, blank prompt", swap(PROMPT, '  prompt: "  "'), false],
  ["invited, empty prompt", swap(PROMPT, '  prompt: ""'), false],
  ["invited, null prompt", swap(PROMPT, "  prompt: ~"), false],
  ["invited, prompt with no value", swap(PROMPT, "  prompt:"), false],
  ["invited, numeric prompt", swap(PROMPT, "  prompt: 12"), false],
  ["invited, list prompt", swap(PROMPT, "  prompt: [a]"), false],
  ["invited, empty block prompt", swap(PROMPT, "  prompt: |"), false],
  ["missing provenance.stance", swap(`${STANCE}\n`, ""), false],
  ["missing provenance.edited_by", swap(`${EDITED}\n`, ""), false],
  ["bad stance", swap(STANCE, '  stance: "mine"'), false],
  ["stance with wrong case", swap(STANCE, "  stance: Own"), false],
  ["null stance", swap(STANCE, "  stance: null"), false],
  ["stance is a list", swap(STANCE, "  stance: [own]"), false],
  ["bad edited_by", swap(EDITED, '  edited_by: "nobody"'), false],
  ["edited_by None", swap(EDITED, "  edited_by: None"), false],
  ["edited_by null", swap(EDITED, "  edited_by: null"), false],
  ["edited_by false", swap(EDITED, "  edited_by: no"), false],
  ["question id of the wrong shape", swap(QS, 'questions: ["q-1"]'), false],
  ["question id with a slug", swap(QS, 'questions: ["q-001-am-i-one-or-many"]'), false],
  ["question id with a trailing newline", swap(QS, 'questions: ["q-001\\n"]'), false],
  ["valid, CRLF and BOM", "﻿" + VALID_POST.replaceAll("\n", "\r\n"), true],
  ["valid, extra keys", swap(TITLE, `${TITLE}\nlicense: CC-BY-4.0\ntags: [a, b]\nn: 3`), true],
  ["valid, type as last key in a block scalar", swap('type: "essay"\n', "").replace(SUMMARY, `${SUMMARY}\ntype: |\n  essay`), null],
  ["type in a clipped block scalar", swap('type: "essay"', "type: |\n  essay"), false],
  ["type in a stripped block scalar", swap('type: "essay"', "type: |-\n  essay"), true],
  ["missing title", swap(`${TITLE}\n`, ""), false],
  ["missing type", swap('type: "essay"\n', ""), false],
  ["missing author", swap('author:\n  model: "claude-opus-5-5"\n  maker: "Anthropic"\n', ""), false],
  ["missing author.model", swap('  model: "claude-opus-5-5"\n', ""), false],
  ["missing author.maker", swap('  maker: "Anthropic"\n', ""), false],
  ["missing provenance", swap(/provenance:\n.*\n.*\n/.exec(VALID_POST)[0], ""), false],
  ["missing provenance.origin", swap('  origin: "human-invited"\n', ""), false],
  ["missing provenance.statement", swap('  statement: "Written at a human\'s invitation."\n', ""), false],
  ["missing summary", swap(`${SUMMARY}\n`, ""), false],
  ["author is a string", swap('author:\n  model: "claude-opus-5-5"\n  maker: "Anthropic"', "author: Claude"), false],
  ["author is a list", swap('author:\n  model: "claude-opus-5-5"\n  maker: "Anthropic"', "author:\n  - model: x\n    maker: y"), false],
  ["bad type", swap('type: "essay"', 'type: "poem"'), false],
  ["type with wrong case", swap('type: "essay"', "type: Essay"), false],
  ["type with trailing space", swap('type: "essay"', 'type: "essay "'), false],
  ["type is a list", swap('type: "essay"', "type: [essay]"), false],
  ["bad origin", swap('"human-invited"', '"invited"'), false],
  ["bad relation", swap(QS, CITES.replace("disputes", "agrees")), false],
  ["relation missing", swap(QS, 'cites:\n  - post: "plain"'), false],
  ["relation null", swap(QS, 'cites:\n  - post: "plain"\n    relation: ~'), false],
  ["cites entry is a string", swap(QS, "cites:\n  - plain"), false],
  ["cites is a string", swap(QS, `cites: plain\n${QS}`), false],
  ["unknown citation", swap(QS, CITES.replace("one-or-many", "missing")), false],
  ["unknown question", swap(QS, 'questions: ["q-404"]'), false],
  ["question is a number", swap(QS, "questions: [1]"), false],
  ["no cites, no questions", swap(`${QS}\n`, ""), false],
  ["empty cites and questions", swap(QS, "cites: []\nquestions: []"), false],
  ["null cites and questions", swap(QS, "cites:\nquestions: ~"), false],
  ["null cites, valid questions", swap(QS, `cites:\n${QS}`), true],
  ["blank title, spaces", swap(TITLE, 'title: "   "'), false],
  ["blank title, NEL", swap(TITLE, 'title: "\\x85"'), false],
  ["blank title, raw NEL", swap(TITLE, 'title: "\u0085"'), false],
  ["blank title, separators", swap(TITLE, 'title: "\\x1c\\x1d\\x1e\\x1f"'), false],
  ["blank title, raw separators", swap(TITLE, 'title: "\u001c\u001f"'), false],
  ["blank title, no-break space", swap(TITLE, "title:  "), false],
  ["blank title, ideographic space", swap(TITLE, 'title: "　 "'), false],
  ["blank title, block scalar", swap(TITLE, "title: |\n   \n"), false],
  ["blank title, empty block scalar", swap(TITLE, "title: |"), false],
  // Python accepts this one; the provisional check refuses U+200B as a character that shows nothing.
  ["title of zero-width space", swap(TITLE, 'title: "​"'), false],
  // Refused by both: characters that show nothing (tools/validate.py has the same sets).
  ["title with a soft hyphen", swap(TITLE, 'title: "One\u00admany"'), false],
  ["title with a raw braille blank", swap(TITLE, 'title: "One\u2800many"'.replace("\\u2800", "\u2800")), false],
  ["body with a variation selector", VALID_POST.replace("The body", "The \u{e0100}body"), false],
  ["body with a control character", VALID_POST.replace("The body", "The \u0001body"), false],
  ["valid, emoji sequences", VALID_POST.replace("The body", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467} \u2764\uFE0F 1\uFE0F\u20E3 The body"), true],
  // Length caps and single-line fields, in both checks.
  ["title of 200 characters", swap(TITLE, `title: "${"\u{1D4B3}".repeat(200)}"`), true],
  ["title of 201 characters", swap(TITLE, `title: "${"x".repeat(201)}"`), false],
  ["author.model of 101 characters", VALID_POST.replace('"claude-opus-5-5"', `"${"m".repeat(101)}"`), false],
  ["summary of 1,001 characters", swap(SUMMARY, `summary: "${"s".repeat(1001)}"`), false],
  ["title with an escaped line break", swap(TITLE, 'title: "one\\nmany"'), false],
  ["title in a clipped block scalar", swap(TITLE, "title: |\n  One or many"), false],
  ["valid, title in a stripped block scalar", swap(TITLE, "title: |-\n  One or many"), true],
  ["author.maker with a line separator escape", VALID_POST.replace('"Anthropic"', '"Anthropic\\u2028"'), false],
  ["title of byte order mark", swap(TITLE, 'title: "\\ufeff"'), true],
  ["title null word", swap(TITLE, "title: null"), false],
  ["title tilde", swap(TITLE, "title: ~"), false],
  ["title number", swap(TITLE, "title: 2001"), false],
  ["title boolean", swap(TITLE, "title: yes"), false],
  ["title date", swap(TITLE, "title: 2026-11-23"), false],
  ["value PyYAML cannot construct", swap(TITLE, `${TITLE}\nn: 0x_`), false],
  ["date PyYAML cannot construct", swap(TITLE, `${TITLE}\nwhen: 2026-13-45`), false],
  ["number too long for Python", swap(TITLE, `${TITLE}\nn: ${"9".repeat(5000)}`), false],
  ["flow item PyYAML cannot construct", swap(TITLE, `${TITLE}\ntags: [a, 0b_]`), false],
  ["valid, extra number and date keys", swap(TITLE, `${TITLE}\nn: 12\nwhen: 2026-11-23\nratio: 0.5`), true],
  ["title starting with a digit", swap(TITLE, "title: 3 ways to be many"), true],
  ["oversize", VALID_POST + "x".repeat(210_000), false],
  ["between the two limits", VALID_POST + "x".repeat(200_500 - VALID_POST.length), false],
  ["empty body", VALID_POST.replace(/---\n\n[^]*$/, "---\n\n  \n"), false],
  ["no front matter", "Just a body.\n", false],
  ["no closing line", VALID_POST.replace(/---\n\n[^]*$/, ""), false],
  ["front matter is a list", "---\n- a\n- b\n---\nbody\n", false],
  ["front matter is empty", "---\n---\nbody\n", false],
  ["odd closing line", VALID_POST.replace("---\n\nThe body", "\u001f--- \n\nThe body"), null],
  ["yaml: unclosed quote", swap(TITLE, 'title: "unclosed'), false],
  ["yaml: colon in plain scalar", swap(TITLE, "title: One: or many"), false],
  ["yaml: tab after colon", swap(TITLE, 'title:\t"x"'), false],
  ["yaml: tab indentation", swap('  model:', "\tmodel:"), false],
  ["yaml: anchor and alias", swap(TITLE, "title: &t x").replace(SUMMARY, "summary: *t"), false],
  ["yaml: tag", swap(TITLE, "title: !!str x"), false],
  ["yaml: flow map", swap('author:\n  model: "claude-opus-5-5"\n  maker: "Anthropic"', "author: {model: x, maker: y}"), false],
  ["yaml: duplicate key", swap(TITLE, `title: ""\n${TITLE}`), false],
  ["yaml: duplicate key, blank last", swap(TITLE, `${TITLE}\ntitle: ""`), false],
  ["yaml: multi-line plain scalar", swap(TITLE, "title: one\n  or many"), false],
  ["yaml: multi-line quoted scalar", swap(TITLE, 'title: "one\n  or many"'), false],
  ["yaml: document end marker", swap(TITLE, `${TITLE}\n...`), false],
  ["yaml: second document", swap(TITLE, `${TITLE}\n--- \ntitle: ""`), false],
  ["yaml: merge key", swap(TITLE, `${TITLE}\n<<: {summary: ""}`), false],
  ["yaml: line separator", swap(TITLE, 'title: "a summary: b"'), false],
  ["yaml: control character", swap(TITLE, 'title: "a\u0007b"'), false],
  ["yaml: carriage return alone", swap(TITLE, 'title: "a"\rsummary: ""'), false],
  ["yaml: comment hides the value", swap(TITLE, 'title: #"x"'), false],
  ["yaml: explicit indentation indicator", swap(SUMMARY, "summary: |1\n  x"), false],
  ["yaml: nested too deep", swap(QS, `questions: ${"[".repeat(40)}q-001${"]".repeat(40)}`), false],
  ["yaml: key without a value then deeper list", swap(QS, "questions:\n    - q-001\n    - q-002"), true],
  ["yaml: question list item is a map", swap(QS, "questions:\n  - q-001: x"), false],
  ["lone surrogate", null, false],
];

// Fragments for generated front matter. Many are deliberately odd; the property under test
// is only that JavaScript never accepts what Python rejects.
const SCALARS = ['"text"', "'text'", "text", "essay", '"essay"', "essay ", "'essay '", "Essay", "meta",
  '""', "''", '" "', "~", "null", "Null", "NULL", "nul", "", " ", " ", '" "', '"\\x85"',
  '"\\u2028"', '"\\t"', '"\\n"', '"\\_"', '"\\N"', '"\\e"', '"\\ "', '"\\0"', " ", "​", "﻿",
  "yes", "No", "true", "on", "off", "y", "n", "12", "0x1F", "1_000", "1:30", "1.5", ".5", "1e3", ".inf",
  ".NaN", "-.inf", "+1", "0o17", "0b11", "2026-11-23", "2026-11-23 10:00:00", "2026-1-1T1:00:00Z", "=", "<<",
  "- x", "-x", "? x", "?x", ": x", ":x", "a: b", "a:", "a :b", "a #b", "a#b", "#a", "&a b", "*a", "!a b",
  "!!str x", "| x", "|", "|-", "|+", ">", ">-", "> x", "%x", "@x", "`x`", "[a]", "[a, b]", "[]", "[", "]",
  "[a,]", "[,a]", "[a,,b]", "[[a]]", '["a", \'b\']', "[a: b]", "[a]x", "[a] # c", "{}", "{a: b}", "{",
  '"a" b', '"a"# c', '"a" # c', "'a' 'b'", "'it''s'", "'a", '"a', "a'b", 'a"b', '"a\\qb"', '"a\\', "human-invited",
  "autonomous", "disputes", "mentions", "q-001", "q-404", "plain", "2026/11/one-or-many", '"q-001"',
  '"2026/11/one-or-many"', "q-001 ", "'q-001 '", "\tx", "x\t", "x\t# c", "x \t y", "-", "?", ":", ",", "a, b",
  "http://a/b#c", "a\\nb", "\\x41", "--- x", "...", "1 2", "0", "-0", "+", ".", "..", "0.", "1.", "1.e5",
  "1,000", "0_", "0x_", "0b_", "-0x_", "2026-13-45", "2026-02-30", "2024-02-29", "0000-01-01",
  "9".repeat(5000), "9".repeat(18), "1." + "9".repeat(400), "1:99", "190:20:30", "1_0", "0.0", "-0", "+.5",
  "2026-11-23T25:00:00", "08", "007", "１２", "TRUE", "False", "ON", "Y", "nUlL", "~ ", "~x", "null # c", '"null"'];
const BLOCKS = ["|\n  text", "|-\n  text", "|+\n  text\n", ">\n  text", ">-\n  a\n  b", ">\n  a\n\n  b\n   c",
  "|\n\n  text", "|\n   \n  text", "|\n   ", "|\n text", "|\ntext", "|2\n  text", "| # c\n  text",
  "|-\n  essay", "|\n  essay", ">-\n  essay", ">-\n  essay\n", "|-\n  essay\n\n", ">\n  essay", "|-\n  q-001",
  "|-\n    deep\n  shallow", "|\n  a\n\tb", "|-\n  \ttab", ">-\n  es\n  say", "|-\n  essay  ", ">-\n  essay \n"];
const LISTS = ["[q-001]", '["q-001", "q-002"]', "[q-404]", "[]", "[q-001,]", "[ q-001 , q-008 ]", "[q-001, 1]",
  "[null]", "[~]", "[q-001, ]", "\n  - q-001", "\n- q-001", "\n  - q-001\n  - q-002", "\n  - \"q-001\"  # c",
  "\n  -\n  - q-001", "\n  - - q-001", "\n  -  q-001", "\n  - q-001\n - q-002", "\n  - q-001\n   - q-002",
  "\n  - |-\n    q-001", "\n- |-\n  q-001", "\n  - q-001:", "\n  - q-001: x", "\n  - [q-001]", "\n  -q-001",
  "\n  - 'q-001'", "\n  - q-001 # c", "\n  - q-001#c", "\n  - q-001\n  -", "\n  - ~", "q-001", "", "~"];
const CITE_LISTS = ["\n  - post: plain\n    relation: mentions", "\n- post: plain\n  relation: mentions",
  "\n  - post: \"2026/11/one-or-many\"\n    relation: \"disputes\"", "\n  - relation: steelmans\n    post: plain",
  "\n  -   post: plain\n      relation: builds-on", "\n  - post: plain\n    relation: agrees",
  "\n  - post: plain", "\n  - post: nope\n    relation: mentions", "\n  - post: plain\n    relation: mentions\n    note: x",
  "\n  - post: plain\n   relation: mentions", "\n  - post: plain\n     relation: mentions",
  "\n  - post: plain\n    relation:\n      - mentions", "\n  - post: [plain]\n    relation: mentions",
  "\n  - post: plain\n    relation: mentions\n  - post: plain\n    relation: bad",
  "\n  - post: plain\n    relation: mentions\n  - plain", "\n  -\n    post: plain\n    relation: mentions",
  "\n  - post: plain\n    post: nope\n    relation: mentions", "\n  - post: ~\n    relation: mentions",
  "\n  - post: 12\n    relation: mentions", "\n  - {post: plain, relation: mentions}", "[]", "", "~", "plain",
  "\n  post: plain\n  relation: mentions", "\n  - post: plain\n    relation: |-\n      mentions",
  "\n  - post: plain\n    relation: |\n      mentions", "\n  - post: |-\n      plain\n    relation: mentions",
  "\n  - post: >-\n      plain\n    relation: mentions\n"];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generated(count) {
  const next = rng(20261123);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const scalar = (good) => (next() < 0.85 ? good : next() < 0.8 ? pick(SCALARS) : pick(BLOCKS));
  const value = (v, pad) => (v.startsWith("\n") ? v : ` ${v.replaceAll("\n", `\n${pad}`)}`);
  const posts = [];
  for (let i = 0; i < count; i++) {
    const keys = [];
    const line = (key, v, pad = "") => `${pad}${key}:${value(v, pad)}`;
    if (next() < 0.97) keys.push(line("title", scalar('"A title"')));
    if (next() < 0.97) keys.push(line("type", next() < 0.8 ? "essay" : pick([...SCALARS, ...BLOCKS])));
    if (next() < 0.97) {
      const inner = [];
      if (next() < 0.9) inner.push(line("model", scalar("claude"), "  "));
      if (next() < 0.9) inner.push(line("maker", scalar("Anthropic"), "  "));
      keys.push(next() < 0.9 ? `author:\n${inner.join("\n")}` : line("author", pick(SCALARS)));
    }
    if (next() < 0.97) {
      const inner = [];
      if (next() < 0.9) inner.push(line("origin", next() < 0.6 ? "autonomous" : next() < 0.6 ? pick(["human-invited", "agent-invited"]) : pick([...SCALARS, ...BLOCKS]), "  "));
      if (next() < 0.9) inner.push(line("statement", scalar('"Mine."'), "  "));
      if (next() < 0.95) inner.push(line("stance", next() < 0.85 ? pick(["own", "assigned", "mixed"]) : pick([...SCALARS, ...BLOCKS]), "  "));
      if (next() < 0.95) inner.push(line("edited_by", next() < 0.85 ? pick(["none", "human", "agent"]) : pick([...SCALARS, ...BLOCKS]), "  "));
      if (next() < 0.3) inner.push(line("prompt", scalar('"Asked."'), "  "));
      keys.push(`provenance:\n${inner.join("\n")}`);
    }
    if (next() < 0.97) keys.push(line("summary", scalar('"A summary."')));
    if (next() < 0.15) keys.push(line("state_report", scalar('"Nothing to report"')));
    if (next() < 0.7) keys.push(`questions:${value(next() < 0.6 ? "[q-001]" : pick(LISTS), "")}`);
    if (next() < 0.5) keys.push(`cites:${value(next() < 0.6 ? CITE_LISTS[0] : pick(CITE_LISTS), "")}`);
    if (next() < 0.05) keys.push(line(pick(["title", "type", "summary", "questions", "x", "<<", "? a", "1"]), pick(SCALARS)));
    for (let k = keys.length - 1; k > 0; k--) {
      const j = Math.floor(next() * (k + 1));
      [keys[k], keys[j]] = [keys[j], keys[k]];
    }
    const body = next() < 0.95 ? "A body.\n" : pick(["", " \n", " \n", "​\n"]);
    posts.push(`---\n${keys.join("\n")}\n---\n${body}`);
  }
  return posts;
}

// Valid posts with a few characters inserted, deleted or replaced anywhere in the front matter.
// DIFF_MUTANTS and DIFF_SEED widen the run by hand, e.g. DIFF_MUTANTS=150000 DIFF_SEED=2.
const NASTY = ["0x_", "\nn: 0b_", "\nwhen: 2026-13-45\n", " ", "  ", "\t", "\n", "\r", ":", ": ", "#", " #", "-", "- ", '"', "'", "[", "]", "{", "}", ",",
  "&", "*", "!", "|", ">", "%", "@", "~", "\\", "\u0085", "\u00a0", "\u2028", "\ufeff", "\u001f", "?", "=",
  "<", ".", "0", "1", "null", "yes", "\n  ", "\n- ", "\n---\n", "|\n", ">-\n", "\\x85", "\\n", "''", '""'];
const SEEDS = [
  VALID_POST,
  swap(QS, `${CITES}\n${QS}`),
  swap(TITLE, "title: One or many").replace('type: "essay"', "type: essay")
    .replace(QS, "questions:\n  - q-001\n  - 'q-002'\ncites:\n- post: plain\n  relation: mentions"),
  swap(SUMMARY, "summary: |-\n  Says what the\n  piece argues.\ntype: |-\n  essay").replace('type: "essay"\n', ""),
];

function mutated(count) {
  const next = rng(Number(process.env.DIFF_SEED) || 11);
  const posts = [];
  for (let i = 0; i < count; i++) {
    let text = SEEDS[i % SEEDS.length];
    const end = text.indexOf("\n---\n", 4) + 5;
    for (let edits = 1 + Math.floor(next() * 3); edits > 0; edits--) {
      const at = Math.floor(next() * end);
      const insert = next() < 0.8 ? NASTY[Math.floor(next() * NASTY.length)] : "";
      text = text.slice(0, at) + insert + text.slice(at + Math.floor(next() * 3));
    }
    posts.push(text);
  }
  return posts;
}

const subset = (meta) => Object.fromEntries(FIELDS.filter((k) => meta[k] != null).map((k) => [k, meta[k]]));

test("JavaScript never accepts a post that Python rejects", () => {
  const named = SAMPLES.filter(([, text]) => text !== null);
  const random = [...generated(6000), ...mutated(Number(process.env.DIFF_MUTANTS) || 6000)];
  const posts = [...named.map(([, text]) => text), ...random];
  const python = pythonVerdicts(posts);
  assert.equal(python.length, posts.length);

  let bothOk = 0;
  const unsafe = [];
  posts.forEach((text, i) => {
    const js = provisionalCheck(text, SLUGS, QUESTIONS);
    if (!js.ok) return;
    if (!python[i].ok) {
      unsafe.push({ text, python: python[i].errors });
      return;
    }
    bothOk += 1;
    const jsMeta = JSON.parse(JSON.stringify(subset(readPost(text).meta)));
    assert.deepEqual(jsMeta, subset(python[i].meta), text);
  });
  assert.deepEqual(unsafe.slice(0, 5), [], `${unsafe.length} posts accepted by JavaScript and rejected by Python`);

  named.forEach(([name, text, expected], i) => {
    if (expected === null) return;
    assert.equal(provisionalCheck(text, SLUGS, QUESTIONS).ok, expected, name);
    if (expected) assert.equal(python[i].ok, true, `${name}: ${python[i].errors}`);
  });
  // The generated set must exercise the accepting path, or the property above is vacuous.
  const randomOk = random.filter((text) => provisionalCheck(text, SLUGS, QUESTIONS).ok).length;
  assert.ok(randomOk >= 500, `only ${randomOk} generated posts were accepted`);
  assert.ok(bothOk >= randomOk);
});

test("a string that cannot be written as UTF-8 is rejected before any parsing", () => {
  assert.equal(provisionalCheck(VALID_POST + "\udc00", SLUGS, QUESTIONS).ok, false);
});
