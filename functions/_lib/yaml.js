// A small YAML reader for post front matter: block maps, block lists, one-line flow lists,
// plain and quoted scalars, and | and > block scalars.
//
// The Python check reads front matter with PyYAML and is the authority. This reader exists
// only to agree with it on ordinary front matter, so it is strict: anything it does not
// handle exactly as PyYAML does (tabs, anchors, tags, flow maps, multi-line scalars,
// duplicate keys, unusual characters) throws YamlError, and the caller reports that the
// provisional check could not parse the post. It must never guess.
//
// A YamlError's message is written for the author: what is wrong and how to write it instead.
// Its `line` is the 0-based line of the front matter where the reader stopped.

export class YamlError extends Error {
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

const fail = (message) => {
  throw new YamlError(message);
};
const QUOTE_IT = "put the whole value in double quotes";

const MAX_DEPTH = 20;
const MAX_KEY_LENGTH = 100;

// Characters PyYAML accepts, less the ones it treats as line breaks or a byte order mark
// (CR, U+0085, U+2028, U+2029, U+FEFF): those would shift where its lines begin and end.
const ALLOWED = /^[\t\n\x20-\x7E\xA0-‧‪-퟿-﻾＀-�\u{10000}-\u{10FFFF}]*$/u;

// PyYAML's YAML 1.1 implicit types. A plain scalar matching one of these is not a string.
const NULL = /^(?:~|null|Null|NULL|)$/;
const BOOL = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const TRUE = /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/;
const OTHER = [
  /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/,
  /^(?:[-+]?[0-9][0-9_]*\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9_]+(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/,
  /^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)$/,
  /^(?:<<|=)$/,
];
// Stands for any number, date or other non-string scalar: callers only need "not a string".
const NOT_A_STRING = 0;

// PyYAML raises on some of what those patterns match: `0x_`, a decimal too long for Python
// to convert, the date 2026-13-45, the lone `=`. Python then rejects the whole post, so only
// forms that are certain to construct are read; the rest are outside the subset.
const SAFE_NUMBER = /^[-+]?(?:0|[1-9][0-9]{0,17}|[0-9]{1,17}\.[0-9]{0,17})$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isRealDate(text) {
  const match = DATE.exec(text);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= MONTH_DAYS[month - 1] + (month === 2 && leap ? 1 : 0);
}

function resolvePlain(text) {
  if (NULL.test(text)) return null;
  if (BOOL.test(text)) return TRUE.test(text);
  if (!OTHER.some((pattern) => pattern.test(text))) return text;
  if (SAFE_NUMBER.test(text) || isRealDate(text)) return NOT_A_STRING;
  return fail(`"${text.slice(0, 40)}" reads as a number or date that this check cannot confirm is valid: ${QUOTE_IT} if it is text`);
}

const KEY = /^([A-Za-z_][A-Za-z0-9_.-]*) *:(?: +(.*))?$/;
const BLOCK_HEADER = /^([|>])([+-]?)(?: +#.*)?$/;
const FLOW_PLAIN = /^[A-Za-z0-9_/.+~-](?:[A-Za-z0-9_/.+~ -]*[A-Za-z0-9_/.+~-])?$/;
const SIMPLE_ESCAPES = { "\\": "\\", '"': '"', "/": "/", n: "\n", t: "\t" };

const isSeqStart = (content) => content === "-" || content.startsWith("- ");
// Only the space is indentation. JavaScript's trim would also strip characters such as
// U+00A0 that YAML reads as content.
function leadingSpaces(line) {
  let n = 0;
  while (line[n] === " ") n++;
  return n;
}
// Trims by walking in from each end. A regex such as / +$/ retries at every space of a long
// run inside the text, which takes quadratic time.
function trimSpaces(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === " ") start++;
  while (end > start && text[end - 1] === " ") end--;
  return text.slice(start, end);
}
// After a closed quote or bracket, only a comment may follow.
function onlyComment(rest) {
  const after = rest.slice(leadingSpaces(rest));
  return after === "" || (after !== rest && after[0] === "#");
}

function readDouble(s, start) {
  let out = "";
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"') return [out, i + 1];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = s[++i];
    if (e in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[e];
    } else if (e === "x" || e === "u") {
      const width = e === "x" ? 2 : 4;
      const hex = s.slice(i + 1, i + 1 + width);
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) {
        fail(`the escape "\\${e}" needs exactly ${width} hexadecimal digits`);
      }
      const code = parseInt(hex, 16);
      if (code >= 0xd800 && code <= 0xdfff) fail(`the escape "\\u${hex}" is half of a surrogate pair, not a character`);
      out += String.fromCharCode(code);
      i += width;
    } else {
      fail(`the escape "\\${e ?? ""}" is not one this check reads (it reads \\\\ \\" \\/ \\n \\t \\xHH and \\uHHHH): `
        + 'for text with backslashes use the "|" form, which takes text as written');
    }
  }
  return fail('unclosed double quote: a double-quoted value must end on the same line; '
    + 'for text with line breaks or quote marks use the "|" form');
}

function readSingle(s, start) {
  let out = "";
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] !== "'") {
      out += s[i];
    } else if (s[i + 1] === "'") {
      out += "'";
      i++;
    } else {
      return [out, i + 1];
    }
  }
  return fail("unclosed single quote: a single-quoted value must end on the same line; "
    + 'for text with line breaks or quote marks use the "|" form');
}

const readQuoted = (s, start) => (s[start] === '"' ? readDouble(s, start) : readSingle(s, start));

const UNCLOSED_LIST = 'a value starting with "[" is read as a list, and this one has no closing "]" on its line: '
  + `${QUOTE_IT} if it is text`;

function readFlowList(s) {
  const items = [];
  let i = 1;
  for (;;) {
    while (s[i] === " ") i++;
    if (s[i] === "]") break;
    if (i >= s.length) fail(UNCLOSED_LIST);
    if (s[i] === '"' || s[i] === "'") {
      const [value, end] = readQuoted(s, i);
      items.push(value);
      i = end;
    } else {
      let end = i;
      while (end < s.length && s[end] !== "," && s[end] !== "]") end++;
      const text = trimSpaces(s.slice(i, end));
      if (!FLOW_PLAIN.test(text) || text === "-" || text.startsWith("- ")) {
        fail(`the list item "${text.slice(0, 40)}" cannot be read unquoted: put each item in double quotes, `
          + `or ${QUOTE_IT} if it is text, not a list`);
      }
      items.push(resolvePlain(text));
      i = end;
    }
    while (s[i] === " ") i++;
    if (s[i] === ",") i++;
    else if (i >= s.length) fail(UNCLOSED_LIST);
    else if (s[i] !== "]") fail('a list in [...] needs a comma between items and a "]" at its end');
  }
  if (!onlyComment(s.slice(i + 1))) {
    fail(`a value starting with "[" is read as a list, so no text may follow its closing "]": ${QUOTE_IT} if it is text`);
  }
  return items;
}

// `onComment` is called when a plain value is cut at " #": YAML reads the rest as a comment.
function readInline(text, onComment) {
  const first = text[0];
  if (first === '"' || first === "'") {
    const [value, end] = readQuoted(text, 0);
    if (!onlyComment(text.slice(end))) {
      fail(`text follows the closing quote mark: ${QUOTE_IT}, or use the "|" form for text that holds quote marks`);
    }
    return value;
  }
  if (first === "[") return readFlowList(text);
  if (first === "{") fail('a value starting with "{" is a flow mapping, which this check does not read: '
    + `write the mapping one key per line, or ${QUOTE_IT} if it is text`);
  if (first === "&" || first === "*") fail('anchors ("&") and aliases ("*") are not accepted: write each value out, '
    + `or ${QUOTE_IT} if it is text`);
  if (first === "!") fail(`tags ("!") are not accepted: ${QUOTE_IT}`);
  if ("}],|>%@`#".includes(first)) fail(`an unquoted value cannot start with "${first}": ${QUOTE_IT}`);
  if ("-?:".includes(first) && (text.length === 1 || text[1] === " ")) {
    fail(`an unquoted value cannot start with "${first} ": ${QUOTE_IT}`);
  }
  const comment = text.indexOf(" #");
  const plain = trimSpaces(comment === -1 ? text : text.slice(0, comment));
  if (plain.includes(": ") || plain.endsWith(":")) {
    fail(`an unquoted value holds a colon followed by a space, which YAML reads as a second key: ${QUOTE_IT}`);
  }
  if (comment !== -1 && onComment) onComment();
  return resolvePlain(plain);
}

class Reader {
  constructor(lines) {
    this.lines = lines;
    this.i = 0;
    this.at = 0; // the line being read, for the error message
    this.comments = []; // {path, line} of each plain value cut at " #"
  }

  // The next line that is not blank or a comment, without consuming it.
  peek() {
    for (; this.i < this.lines.length; this.i++) {
      const line = this.lines[this.i];
      this.at = this.i;
      if (line.includes("\t")) {
        fail('a tab character: indent with spaces, and keep tabs only inside a "|" block');
      }
      const indent = leadingSpaces(line);
      const content = trimSpaces(line.slice(indent));
      if (content !== "" && !content.startsWith("#")) return { indent, content };
    }
    return null;
  }

  node(indent, depth, path) {
    if (depth > MAX_DEPTH) fail("the front matter is nested too deeply");
    return isSeqStart(this.peek().content) ? this.list(indent, depth, path) : this.map(indent, depth, path);
  }

  map(indent, depth, path) {
    const out = Object.create(null);
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) return out;
      if (line.indent > indent) fail(UNEXPECTED_INDENT);
      const match = KEY.exec(line.content);
      if (!match || match[1].length > MAX_KEY_LENGTH) {
        fail("expected `key: value` here (a key is letters, digits, _ . and -, followed by a colon and a space)");
      }
      if (match[1] in out) fail(`duplicate key "${match[1]}": each key may appear once`);
      this.i++;
      out[match[1]] = this.value(match[2] ?? "", indent, depth, true, path ? `${path}.${match[1]}` : match[1]);
    }
  }

  list(indent, depth, path) {
    const out = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) return out;
      if (line.indent > indent) fail(UNEXPECTED_INDENT);
      // A list written flush with its key ends at the next key; the caller checks that line.
      if (!isSeqStart(line.content)) return out;
      const rest = line.content.slice(1);
      const item = rest.slice(leadingSpaces(rest));
      if (isSeqStart(item) || KEY.test(item)) {
        // `- key: value` and `- - x` open a nested block at the column where the item starts.
        const column = indent + 1 + (rest.length - item.length);
        this.lines[this.i] = " ".repeat(column) + item;
        out.push(this.node(column, depth + 1, `${path}[${out.length}]`));
      } else {
        this.i++;
        out.push(this.value(item, indent, depth, false, `${path}[${out.length}]`));
      }
    }
  }

  // The value after `key:` or `- `. `parentIndent` is the indent of that key or dash.
  value(rest, parentIndent, depth, isMapValue, path) {
    const text = trimSpaces(rest);
    if (text === "" || text.startsWith("#")) {
      const at = this.at;
      const next = this.peek();
      if (next && next.indent > parentIndent) return this.node(next.indent, depth + 1, path);
      if (isMapValue && next && next.indent === parentIndent && isSeqStart(next.content)) {
        return this.list(parentIndent, depth + 1, path);
      }
      this.at = at;
      return null;
    }
    if (text[0] === "|" || text[0] === ">") {
      const header = BLOCK_HEADER.exec(text);
      if (!header) {
        fail(`after "${text[0]}" only "-" or "+" and a comment may follow on the same line; `
          + "the text goes on the lines beneath, indented");
      }
      return this.blockScalar(header[1], header[2], parentIndent);
    }
    const line = this.at;
    return readInline(text, () => this.comments.push({ path, line }));
  }

  blockScalar(style, chomp, parentIndent) {
    const body = [];
    let indent = null;
    let widestLeadingBlank = 0;
    let endedByLine = false;
    for (; this.i < this.lines.length; this.i++) {
      const line = this.lines[this.i];
      this.at = this.i;
      const spaces = leadingSpaces(line);
      const blank = spaces === line.length;
      if (blank) {
        if (indent === null) {
          widestLeadingBlank = Math.max(widestLeadingBlank, spaces);
          body.push("");
        } else {
          body.push(" ".repeat(Math.max(0, spaces - indent)));
        }
        continue;
      }
      if (indent === null) {
        if (spaces <= parentIndent) {
          endedByLine = true;
          break;
        }
        if (widestLeadingBlank > spaces) {
          fail("a blank line at the start of the block is indented further than its first line of text");
        }
        indent = spaces;
      } else if (spaces < indent) {
        endedByLine = true;
        break;
      }
      body.push(line.slice(indent));
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === "") {
      body.pop();
      trailing++;
    }
    // Line breaks after the last content line. The stream has no final newline, so a block
    // that runs to the end of the front matter has one fewer.
    const breaks = trailing + (body.length && endedByLine ? 1 : 0);
    let text;
    if (style === "|") {
      text = body.join("\n");
    } else {
      if (body.some((l) => l.startsWith(" ") || l.startsWith("\t"))) {
        fail('a ">" block with lines indented further than its first: use the "|" form');
      }
      text = "";
      let blanks = 0;
      let started = false;
      for (const l of body) {
        if (l === "") {
          blanks++;
          continue;
        }
        text += (started && blanks === 0 ? " " : "\n".repeat(blanks)) + l;
        started = true;
        blanks = 0;
      }
    }
    if (chomp === "-") return text;
    if (chomp === "+") return text + "\n".repeat(breaks);
    return text + (body.length && breaks > 0 ? "\n" : "");
  }
}

// The first character outside ALLOWED, as a YamlError on its line.
function unsupportedCharacter(text) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const char of lines[i]) {
      if (!ALLOWED.test(char)) {
        const code = char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
        return new YamlError(`the character U+${code} is not accepted in front matter: remove it`, i);
      }
    }
  }
  return new YamlError("the front matter holds characters this check does not read", 0);
}

const UNEXPECTED_INDENT = "this line is indented further than the keys around it: a value that runs onto a second "
  + 'line needs the "|" form, and the keys of one mapping start in the same column';

// Returns the document's value: a null-prototype object for a map, an array for a list, or
// null for an empty document. Throws YamlError on anything outside the supported subset.
// `comments`, when given, receives {path, line} for each plain value cut short at " #".
export function parseYaml(text, comments) {
  if (typeof text !== "string") throw new YamlError("front matter must be text", 0);
  if (!ALLOWED.test(text)) throw unsupportedCharacter(text);
  const reader = new Reader(text.split("\n"));
  try {
    const first = reader.peek();
    if (!first) return null;
    const value = reader.node(first.indent, 0, "");
    if (reader.peek()) fail("unexpected content after the front matter's top-level keys");
    if (comments) comments.push(...reader.comments);
    return value;
  } catch (e) {
    const error = e instanceof YamlError ? e : new YamlError(String(e && e.message));
    if (error.line === undefined) error.line = reader.at;
    throw error;
  }
}
