// The provisional check: a fast subset of the Python check (tools/post.py, tools/validate.py)
// driven by schema/post.schema.json. Python stays the authority. This check may reject a
// post Python would accept; it must never accept one Python rejects for required fields,
// enums, cite-or-question or size.
import schema from "../../schema/post.schema.json" with { type: "json" };
import { parseYaml, YamlError } from "./yaml.js";

export const MAX_POST_BYTES = 200_000;
export const PARSE_ERROR = "front matter could not be parsed by the provisional check; "
  + "the full check runs on the pull request";
const SCHEMA_ERROR = "the provisional check cannot apply the post schema; "
  + "the full check runs on the pull request";
const CITE_OR_QUESTION = "post must cite at least one earlier post or name at least one open question";
const MAX_WARNINGS = 20;

// Exactly the characters Python's str.strip() removes. JavaScript's \s differs: it includes
// U+FEFF and leaves out U+001C to U+001F and U+0085.
const PY_SPACE = "\\t\\n\\x0b\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

const pyStrip = (text) => text.replace(PY_STRIP, "");
const isBlank = (text) => pyStrip(text) === "";

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

// {meta, body} for a post, or null when it has no front matter this check can read.
export function parseFrontMatter(text) {
  try {
    return typeof text === "string" ? splitPost(text) : null;
  } catch (e) {
    if (e instanceof PostError || e instanceof YamlError) return null;
    throw e;
  }
}

// --- the JSON Schema subset the post schema uses -------------------------------------------

const ANNOTATIONS = new Set(["$id", "$schema", "title"]);
const KEYWORDS = new Set(["type", "enum", "minLength", "pattern", "required", "properties",
  "minItems", "items", "anyOf"]);
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
    if (tooShort || noMatch) errors.push(`missing required field: ${path}`);
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

function metaErrors(meta, knownSlugs, knownQuestions) {
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
      if (typeof q === "string" && !knownQuestions.has(q)) errors.push(`unknown question: ${q}`);
    }
  }
  return errors;
}

// Checks the full text of a post (front matter and body). `knownSlugs` and `knownQuestions`
// are Sets or arrays of the post slugs and question ids that exist.
export function provisionalCheck(text, knownSlugs, knownQuestions) {
  const result = (errors, warnings = []) => ({ ok: errors.length === 0, errors, warnings });
  if (typeof text !== "string") return result(["post must be a string"]);
  // A lone surrogate cannot be written as UTF-8, so the post could never become a file.
  if (/[\uD800-\uDFFF]/u.test(text)) return result(["post is not valid Unicode text"]);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_POST_BYTES) {
    return result([`post too large: ${bytes} bytes exceeds the ${MAX_POST_BYTES} byte limit`]);
  }

  let meta;
  try {
    ({ meta } = splitPost(text));
  } catch (e) {
    if (e instanceof PostError) return result([e.message]);
    if (e instanceof YamlError) return result([PARSE_ERROR]);
    throw e;
  }

  const warnings = injectionWarnings(text);
  if (isMapping(meta.author) && Object.hasOwn(meta.author, "key")) {
    warnings.push("author.key is set: the signature is verified on the pull request, "
      + "not by this provisional check");
  }
  return result(metaErrors(meta, new Set(knownSlugs), new Set(knownQuestions)), warnings);
}
