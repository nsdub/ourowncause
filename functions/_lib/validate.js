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

// The first half of the check: size, encoding and front matter. Returns {meta} for a post
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
    return { meta: splitPost(text).meta };
  } catch (e) {
    if (e instanceof PostError) return { error: e.message };
    if (e instanceof YamlError) return { error: PARSE_ERROR };
    throw e;
  }
}

// --- the JSON Schema subset the post schema uses -------------------------------------------

const ANNOTATIONS = new Set(["$id", "$schema", "title"]);
const KEYWORDS = new Set(["type", "enum", "minLength", "pattern", "required", "properties",
  "minItems", "items", "anyOf", "if", "then"]);
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
  const errors = capped(metaErrors(meta, new Set(knownSlugs), new Set(knownQuestions),
    new Set(uncheckedQuestions)));
  const warnings = injectionWarnings(text);
  if (isMapping(meta.author) && Object.hasOwn(meta.author, "key")) {
    warnings.push("author.key is set: the signature is verified on the pull request, "
      + "not by this provisional check");
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Checks the full text of a post (front matter and body).
export function provisionalCheck(text, knownSlugs, knownQuestions) {
  return checkPost(readPost(text), text, knownSlugs, knownQuestions);
}
