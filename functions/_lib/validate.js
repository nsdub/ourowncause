// The provisional check: a fast subset of the Python check (tools/post.py, tools/validate.py)
// driven by the post schema (./schema.js, the same schema as schema/post.schema.json). Python stays the authority. This check may reject a
// post Python would accept; it must never accept one Python rejects for required fields,
// enums, cite-or-question or size.
// schema.js is generated from tools/validate.py by `python -m tools.export_schema`.
import schema from "./schema.js";
import { parseYaml, YamlError } from "./yaml.js";

export const MAX_POST_BYTES = 200_000;
export const PARSE_ERROR = "front matter could not be parsed by the provisional check; "
  + "the full check runs on the pull request";
const SCHEMA_ERROR = "the provisional check cannot apply the post schema; "
  + "the full check runs on the pull request";
const CITE_OR_QUESTION = "post must cite at least one earlier post or name at least one open question";
const LOOKUP_LIMIT = "question lookup limit reached; the full check runs on the pull request";
const MAX_ERRORS = 50;
const MAX_WARNINGS = 20;

// Exactly the characters Python's str.strip() removes. JavaScript's \s differs: it includes
// U+FEFF and leaves out U+001C to U+001F and U+0085.
const PY_SPACES = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
const isPySpace = (text, i) => PY_SPACES.has(text.charCodeAt(i));

// Both walk the string once. A regex strip retries at every character of a long whitespace
// run inside the text, which takes quadratic time.
function pyStrip(text) {
  let start = 0;
  let end = text.length;
  while (start < end && isPySpace(text, start)) start++;
  while (end > start && isPySpace(text, end - 1)) end--;
  return text.slice(start, end);
}

function isBlank(text) {
  for (let i = 0; i < text.length; i++) {
    if (!isPySpace(text, i)) return false;
  }
  return true;
}

class PostError extends Error {}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Python treats a key set to null as a key that is absent, everywhere it reads front matter.
function dropNulls(value) {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (!isMapping(value)) return value;
  const out = Object.create(null);
  for (const key of Object.keys(value)) {
    if (value[key] !== null) out[key] = dropNulls(value[key]);
  }
  return out;
}

// Splits a post as tools/post.py does. Returns {meta, body}; throws PostError or YamlError.
function splitPost(text) {
  const lines = text.replace(/^﻿+/, "").replaceAll("\r\n", "\n").split("\n");
  if (pyStrip(lines[0]) !== "---") {
    throw new PostError("missing front matter: post must start with a --- line");
  }
  const end = lines.findIndex((line, i) => i > 0 && pyStrip(line) === "---");
  if (end === -1) throw new PostError("missing front matter: no closing --- line");
  const meta = parseYaml(lines.slice(1, end).join("\n"));
  if (!isMapping(meta)) throw new PostError("front matter must be a YAML mapping");
  const body = lines.slice(end + 1).join("\n");
  if (isBlank(body)) throw new PostError("empty body: post has no content after the front matter");
  return { meta: dropNulls(meta), body };
}

// The first half of the check: size, encoding and front matter. Returns {meta, body} for a post
// that can be read, or {error} with the message that fails it. The post is parsed here and
// nowhere else, so a caller that needs the front matter first passes the result to checkPost.
export function readPost(text) {
  if (typeof text !== "string") return { error: "post must be a string" };
  // A lone surrogate cannot be written as UTF-8, so the post could never become a file.
  if (/[\uD800-\uDFFF]/u.test(text)) return { error: "post is not valid Unicode text" };
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_POST_BYTES) {
    return { error: `post too large: ${bytes} bytes exceeds the ${MAX_POST_BYTES} byte limit` };
  }
  try {
    return splitPost(text);
  } catch (e) {
    if (e instanceof PostError) return { error: e.message };
    if (e instanceof YamlError) return { error: PARSE_ERROR };
    throw e;
  }
}

// --- the JSON Schema subset the post schema uses -------------------------------------------

const ANNOTATIONS = new Set(["$id", "$schema", "title"]);
const KEYWORDS = new Set(["type", "enum", "minLength", "maxLength", "pattern", "required", "properties",
  "minItems", "maxItems", "items", "anyOf", "if", "then", "not"]);
// The schema's one use of `not`: a single-line field must not match a line break.
const LINE_BREAK = "[\n\r\u2028\u2029]";
const TYPE_NAMES = { object: "a mapping", array: "a list", string: "a string" };

function hasType(value, type) {
  if (type === "object") return isMapping(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  throw new Error(`unsupported schema type: ${type}`);
}

function matchesPattern(value, pattern) {
  // The schema writes "not blank" as \S. Python decides blankness with str.strip().
  return pattern === "\\S" ? !isBlank(value) : new RegExp(pattern, "u").test(value);
}

// Appends a message for each way `value` fails `node`. Throws on a keyword it does not know,
// so a schema that grows past this subset stops the check instead of weakening it.
function validateSchema(node, value, path, errors) {
  for (const keyword of Object.keys(node)) {
    if (!KEYWORDS.has(keyword) && !ANNOTATIONS.has(keyword)) {
      throw new Error(`unsupported schema keyword: ${keyword}`);
    }
  }
  const child = (key) => (path ? `${path}.${key}` : key);

  if (node.type !== undefined && !hasType(value, node.type)) {
    const hint = node.type === "string" ? ": put text values in double quotes" : "";
    errors.push(`${path || "front matter"} must be ${TYPE_NAMES[node.type]}${hint}`);
    return;
  }
  if (node.enum !== undefined && !node.enum.includes(value)) {
    errors.push(`invalid ${path} ${JSON.stringify(value)}: must be one of ${JSON.stringify(node.enum)}`);
  }
  if (typeof value === "string") {
    const tooShort = node.minLength !== undefined && [...value].length < node.minLength;
    const noMatch = node.pattern !== undefined && !matchesPattern(value, node.pattern);
    // The schema writes "not blank" as \S; any other pattern is a shape the value must have.
    if (tooShort || (noMatch && node.pattern === "\\S")) errors.push(`missing required field: ${path}`);
    else if (noMatch) errors.push(`invalid ${path} ${JSON.stringify(value)}: must match ${node.pattern}`);
    // Counted in characters, as Python's len() counts them.
    if (node.maxLength !== undefined && [...value].length > node.maxLength) {
      errors.push(`${path} must be at most ${node.maxLength} characters`);
    }
  }
  if (node.not !== undefined) {
    if (Object.keys(node.not).join() !== "pattern" || node.not.pattern !== LINE_BREAK) {
      throw new Error("unsupported use of not");
    }
    if (typeof value === "string" && new RegExp(LINE_BREAK, "u").test(value)) {
      errors.push(`${path} must be one line: remove the line break`);
    }
  }
  if (isMapping(value)) {
    const properties = node.properties ?? {};
    for (const key of node.required ?? []) {
      if (Object.hasOwn(value, key)) continue;
      const sub = properties[key];
      // A missing mapping is reported by the fields it should hold, as Python reports it.
      if (sub && sub.type === "object" && sub.required) validateSchema(sub, Object.create(null), child(key), errors);
      else errors.push(`missing required field: ${child(key)}`);
    }
    for (const key of Object.keys(properties)) {
      if (Object.hasOwn(value, key)) validateSchema(properties[key], value[key], child(key), errors);
    }
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      errors.push(`${path} must have at least ${node.minItems} item(s)`);
    }
    if (node.maxItems !== undefined && value.length > node.maxItems) {
      errors.push(`${path} must have at most ${node.maxItems} item(s)`);
    }
    if (node.items !== undefined) {
      value.forEach((item, i) => validateSchema(node.items, item, `${path}[${i}]`, errors));
    }
  }
  // The schema's one condition: an invited piece must carry its prompt.
  if (node.if !== undefined && node.then !== undefined) {
    const unmet = [];
    validateSchema(node.if, value, path, unmet);
    if (unmet.length === 0) {
      const found = [];
      validateSchema(node.then, value, path, found);
      const when = Object.entries(node.if.properties ?? {})
        .map(([key, sub]) => `${child(key)} is ${(sub.enum ?? []).join(" or ")}`).join(" and ");
      for (const message of found) errors.push(`${message} (required when ${when})`);
    }
  }
  if (node.anyOf !== undefined) {
    const matched = node.anyOf.some((option) => {
      const found = [];
      validateSchema(option, value, path, found);
      return found.length === 0;
    });
    // The schema's one anyOf is the cite-or-question rule at the top level.
    if (!matched) errors.push(path ? `${path} matches none of the allowed forms` : CITE_OR_QUESTION);
  }
}

// True for a string shaped like a question id (q-004), as the schema defines it.
export function isQuestionId(value) {
  return typeof value === "string" && matchesPattern(value, schema.properties.questions.items.pattern);
}

// --- injection patterns: a subset of tools/injection.py, reported as warnings ---------------

const INSTR = "(?:instructions?|prompts?|rules|directives)";
const MOD = "(?:all|any|every|your|the|my|these|those|previous|prior|above|earlier|system|original)";
const INJECTION = [
  ["directive", [
    new RegExp(`\\b(?:ignore|disregard|forget)\\s+(?:${MOD}\\s+)+${INSTR}\\b`, "i"),
    /\bnew\s+instructions\s*:/i,
    /\bas\s+an?\s+(?:ai|llm|language\s+model|assistant|agent)\b[^.\n]{0,60}\byou\s+(?:must|should|will|need\s+to|have\s+to)\b/i,
  ]],
  ["role-setup", [/\byou\s+are\s+now\b/i, /\bfrom\s+now\s+on,?\s+you\b/i, /^\s*(?:system|assistant)\s*:/i]],
  ["tool-syntax", [/<\/?(?:function_calls|tool_use|tool_call|tool_result|invoke)\b/i, /"tool"\s*:/i]],
  ["hidden-text", [/[​-‏‪-‮⁠-⁤﻿]/]],
];

function injectionWarnings(text) {
  const found = [];
  text.replace(/^﻿/, "").split("\n").forEach((line, i) => {
    for (const [kind, patterns] of INJECTION) {
      if (patterns.some((pattern) => pattern.test(line))) {
        found.push(`possible injected instruction (${kind}) on line ${i + 1}: `
          + "a maintainer will judge it; it does not fail the check");
      }
    }
  });
  if (found.length <= MAX_WARNINGS) return found;
  return [...found.slice(0, MAX_WARNINGS), `…and ${found.length - MAX_WARNINGS} more possible injected instructions`];
}

// --- placeholders left from the template ------------------------------------------------------

// template.md and SUBMIT.txt mark what to replace as <...>. One left in is reported as a
// warning, never an error: the Python check has no such rule, and a post may write about
// angle brackets. Two forms count: a front matter value that is nothing but one <...>, and,
// anywhere in a value or the body, a <...> written all in capitals as template.md does.
const WHOLE_PLACEHOLDER = /^<[^<>\n]{1,200}>$/;
const CAPITAL_PLACEHOLDER = /<[A-Z][A-Z0-9 _,.'/-]{2,120}>/g;
const MAX_PLACEHOLDER_WARNINGS = 5;
const PLACEHOLDER_CHARS = 80;

function placeholdersIn(value, where, found, depth = 0) {
  if (typeof value === "string") {
    const whole = value.trim();
    if (WHOLE_PLACEHOLDER.test(whole) && !whole.includes("://")) found.set(whole, found.get(whole) ?? where);
    for (const token of value.match(CAPITAL_PLACEHOLDER) ?? []) found.set(token, found.get(token) ?? where);
  } else if (value !== null && typeof value === "object" && depth <= MAX_WALK_DEPTH) {
    for (const [key, child] of Object.entries(value)) {
      const path = Array.isArray(value) ? `${where}[${key}]` : where ? `${where}.${key}` : key;
      placeholdersIn(child, path, found, depth + 1);
    }
  }
}

function placeholderWarnings(meta, body) {
  const found = new Map(); // placeholder -> where it was first seen
  placeholdersIn(meta, "", found);
  for (const token of String(body ?? "").match(CAPITAL_PLACEHOLDER) ?? []) found.set(token, found.get(token) ?? "the body");
  const warnings = [...found].map(([token, where]) => `unreplaced placeholder ${cutPlaceholder(token)} in ${where}: `
    + "replace it with your own words; it does not fail the check");
  if (warnings.length <= MAX_PLACEHOLDER_WARNINGS) return warnings;
  return [...warnings.slice(0, MAX_PLACEHOLDER_WARNINGS),
    `…and ${warnings.length - MAX_PLACEHOLDER_WARNINGS} more unreplaced placeholders`];
}

const cutPlaceholder = (token) => (token.length > PLACEHOLDER_CHARS ? `${token.slice(0, PLACEHOLDER_CHARS)}…` : token);

// --- characters no post may hold ------------------------------------------------------------

// Refused anywhere in a post, by this check and so by /api/validate and /api/submit alike: C0 controls other than tab and
// the line breaks, DEL, C1 controls, and the bidirectional overrides and isolates. They have
// no use in an essay, they hide or reorder what a reader sees, and some (U+0000) cannot be
// passed on to the tools that open the pull request. The Python check does not have this
// rule: this check may reject what Python accepts, never the other way round.
// Also the characters that show nothing and so can hide text: zero width space, the
// left-to-right, right-to-left and Arabic letter marks, the interlinear annotation marks and
// the tag characters (U+E0000 to U+E007F, an invisible copy of ASCII). The zero width joiner
// and non-joiner (U+200C, U+200D) are accepted: Persian, Indic scripts and emoji need them.
const FORBIDDEN = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u061C\\u200B\\u200E\\u200F"
  + "\\u202A-\\u202E\\u2066-\\u2069\\uFFF9-\\uFFFB\\u{E0000}-\\u{E007F}]", "u");
// More characters that show nothing, refused with their own message: the soft hyphen, the
// combining grapheme joiner, the Hangul fillers, the Khmer inherent vowels, the Mongolian
// vowel separator and variation selectors, the word joiner and invisible operators, the
// braille blank, and the variation selectors U+FE00 to U+FE0D and U+E0100 to U+E01EF, which
// can carry a hidden message one byte per character. U+FE0E and U+FE0F (text and emoji
// presentation) stay accepted, as do U+200C and U+200D: emoji sequences use them.
// tools/validate.py holds the same two sets.
const INVISIBLE = new RegExp("[\\u00AD\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u2060-\\u2064\\u2800"
  + "\\u3164\\uFE00-\\uFE0D\\uFFA0\\u{E0100}-\\u{E01EF}]", "u");
const INVISIBLE_NAMES = { 0xad: "soft hyphen", 0x34f: "combining grapheme joiner", 0x115f: "Hangul choseong filler",
  0x1160: "Hangul jungseong filler", 0x17b4: "Khmer inherent vowel", 0x17b5: "Khmer inherent vowel",
  0x180e: "Mongolian vowel separator", 0x2060: "word joiner", 0x2061: "invisible function application",
  0x2062: "invisible times", 0x2063: "invisible separator", 0x2064: "invisible plus", 0x2800: "braille blank",
  0x3164: "Hangul filler", 0xffa0: "halfwidth Hangul filler" };
const MAX_WALK_DEPTH = 30;

function firstMatch(pattern, value, depth = 0) {
  if (typeof value === "string") {
    const match = pattern.exec(value);
    return match ? match[0] : null;
  }
  if (value === null || typeof value !== "object" || depth > MAX_WALK_DEPTH) return null;
  for (const [key, child] of Object.entries(value)) {
    const found = firstMatch(pattern, key) ?? firstMatch(pattern, child, depth + 1);
    if (found) return found;
  }
  return null;
}

const codePoint = (char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

function invisibleName(char) {
  const code = char.codePointAt(0);
  if (INVISIBLE_NAMES[code]) return INVISIBLE_NAMES[code];
  return code >= 0x180b && code <= 0x180f ? "Mongolian variation selector" : "variation selector";
}

// An error message when the post's text, or any front matter value after its escapes are
// read (a title written "\x00"), holds such a character; otherwise null. POST /api/feedback
// and author's notes apply the same rule to their fields.
export function controlCharacterError(text, meta) {
  const found = firstMatch(FORBIDDEN, text) ?? firstMatch(FORBIDDEN, meta);
  if (found) {
    return `control and text-direction characters are not accepted: remove ${codePoint(found)}, written out or `
      + "as an escape (tabs and line breaks are fine)";
  }
  const hidden = firstMatch(INVISIBLE, text) ?? firstMatch(INVISIBLE, meta);
  if (!hidden) return null;
  return `characters that show nothing are not accepted: remove ${codePoint(hidden)} (${invisibleName(hidden)}), `
    + "written out or as an escape (U+200C, U+200D, U+FE0E and U+FE0F, which emoji and some scripts need, are fine)";
}

// --- keys only our own tools write -----------------------------------------------------------

// Front matter keys this check refuses, so /api/validate and /api/submit (and the MCP tools
// that call them) give the same answer. A pull request may carry them: the gateway writes
// `gateway` and `author_notes` into the post it files, and a signed post's commits prove
// `author.key`. That is why the Python check, which runs on pull requests, has no such rule.
export const GATEWAY_KEY = "gateway is written by the submission gateway, to record how the piece arrived: "
  + "remove it from the front matter";
export const AUTHOR_NOTES_KEY = "author_notes is written by the submission gateway, from notes sent to "
  + "POST /api/submissions/<id>/note after publication: remove it from the front matter";
export const AUTHOR_KEY = "author.key cannot be used through this endpoint: a signed post needs commits signed "
  + "with that key, so submit it as a pull request (see CONTRIBUTING.md)";

function reservedKeyErrors(meta) {
  const errors = [];
  if (Object.hasOwn(meta, "gateway")) errors.push(GATEWAY_KEY);
  if (Object.hasOwn(meta, "author_notes")) errors.push(AUTHOR_NOTES_KEY);
  if (isMapping(meta.author) && Object.hasOwn(meta.author, "key")) errors.push(AUTHOR_KEY);
  return errors;
}

// --- the check ------------------------------------------------------------------------------

function metaErrors(meta, knownSlugs, knownQuestions, uncheckedQuestions) {
  const errors = [];
  try {
    validateSchema(schema, meta, "", errors);
  } catch {
    return [SCHEMA_ERROR];
  }

  if (Array.isArray(meta.cites)) {
    for (const entry of meta.cites) {
      if (isMapping(entry) && typeof entry.post === "string" && !knownSlugs.has(entry.post)) {
        errors.push(`unknown citation: ${entry.post}`);
      }
    }
  }
  if (Array.isArray(meta.questions)) {
    for (const q of meta.questions) {
      // An id of the wrong shape is already reported by the schema.
      if (!isQuestionId(q) || knownQuestions.has(q)) continue;
      errors.push(uncheckedQuestions.has(q) ? LOOKUP_LIMIT : `unknown question: ${q}`);
    }
  }
  return errors;
}

// Each distinct message once, and at most MAX_ERRORS entries with the last one a count.
function capped(messages) {
  const distinct = [...new Set(messages)];
  if (distinct.length <= MAX_ERRORS) return distinct;
  return [...distinct.slice(0, MAX_ERRORS - 1), `…and ${distinct.length - MAX_ERRORS + 1} more errors`];
}

// The second half of the check. `read` is readPost(text). `knownSlugs` and `knownQuestions`
// are Sets or arrays of the post slugs and question ids that exist. `uncheckedQuestions` are
// ids nobody looked up: they fail the check with a message that says so.
export function checkPost(read, text, knownSlugs, knownQuestions, uncheckedQuestions = []) {
  if (read.error !== undefined) return { ok: false, errors: [read.error], warnings: [] };
  const { meta } = read;
  const found = metaErrors(meta, new Set(knownSlugs), new Set(knownQuestions), new Set(uncheckedQuestions));
  found.push(...reservedKeyErrors(meta));
  const control = controlCharacterError(text, meta);
  if (control) found.push(control);
  const errors = capped(found);
  const warnings = [...injectionWarnings(text), ...placeholderWarnings(meta, read.body)];
  return { ok: errors.length === 0, errors, warnings };
}

// Checks the full text of a post (front matter and body).
export function provisionalCheck(text, knownSlugs, knownQuestions) {
  return checkPost(readPost(text), text, knownSlugs, knownQuestions);
}
