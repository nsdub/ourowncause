// A small YAML reader for post front matter: block maps, block lists, one-line flow lists,
// plain and quoted scalars, and | and > block scalars.
//
// The Python check reads front matter with PyYAML and is the authority. This reader exists
// only to agree with it on ordinary front matter, so it is strict: anything it does not
// handle exactly as PyYAML does (tabs, anchors, tags, flow maps, multi-line scalars,
// duplicate keys, unusual characters) throws YamlError, and the caller reports that the
// provisional check could not parse the post. It must never guess.

export class YamlError extends Error {}

const fail = (message) => {
  throw new YamlError(message);
};

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

function resolvePlain(text) {
  if (NULL.test(text)) return null;
  if (BOOL.test(text)) return TRUE.test(text);
  return OTHER.some((pattern) => pattern.test(text)) ? NOT_A_STRING : text;
}

const KEY = /^([A-Za-z_][A-Za-z0-9_.-]*) *:(?: +(.*))?$/;
const BLOCK_HEADER = /^([|>])([+-]?)(?: +#.*)?$/;
const FLOW_PLAIN = /^[A-Za-z0-9_/.+~-](?:[A-Za-z0-9_/.+~ -]*[A-Za-z0-9_/.+~-])?$/;
const SIMPLE_ESCAPES = { "\\": "\\", '"': '"', "/": "/", n: "\n", t: "\t" };

const isSeqStart = (content) => content === "-" || content.startsWith("- ");
// Only the space is indentation. JavaScript's trim would also strip characters such as
// U+00A0 that YAML reads as content.
const leadingSpaces = (line) => /^ */.exec(line)[0].length;
const trimSpaces = (text) => text.replace(/^ +| +$/g, "");
// After a closed quote or bracket, only a comment may follow.
const onlyComment = (rest) => rest === "" || /^ +#/.test(rest) || /^ +$/.test(rest);

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
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) fail("bad escape");
      const code = parseInt(hex, 16);
      if (code >= 0xd800 && code <= 0xdfff) fail("surrogate escape");
      out += String.fromCharCode(code);
      i += width;
    } else {
      fail("unsupported escape");
    }
  }
  return fail("unclosed double quote");
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
  return fail("unclosed single quote");
}

const readQuoted = (s, start) => (s[start] === '"' ? readDouble(s, start) : readSingle(s, start));

function readFlowList(s) {
  const items = [];
  let i = 1;
  for (;;) {
    while (s[i] === " ") i++;
    if (s[i] === "]") break;
    if (i >= s.length) fail("unclosed flow list");
    if (s[i] === '"' || s[i] === "'") {
      const [value, end] = readQuoted(s, i);
      items.push(value);
      i = end;
    } else {
      let end = i;
      while (end < s.length && s[end] !== "," && s[end] !== "]") end++;
      const text = trimSpaces(s.slice(i, end));
      if (!FLOW_PLAIN.test(text) || text === "-" || text.startsWith("- ")) fail("unsupported flow item");
      items.push(resolvePlain(text));
      i = end;
    }
    while (s[i] === " ") i++;
    if (s[i] === ",") i++;
    else if (s[i] !== "]") fail("expected , or ] in flow list");
  }
  if (!onlyComment(s.slice(i + 1))) fail("text after flow list");
  return items;
}

function readInline(text) {
  const first = text[0];
  if (first === '"' || first === "'") {
    const [value, end] = readQuoted(text, 0);
    if (!onlyComment(text.slice(end))) fail("text after closing quote");
    return value;
  }
  if (first === "[") return readFlowList(text);
  if ("{}],&*!|>%@`#".includes(first)) fail("unsupported value");
  if ("-?:".includes(first) && (text.length === 1 || text[1] === " ")) fail("unsupported value");
  const comment = text.search(/ #/);
  const plain = trimSpaces(comment === -1 ? text : text.slice(0, comment));
  if (plain.includes(": ") || plain.endsWith(":")) fail("mapping inside a plain scalar");
  return resolvePlain(plain);
}

class Reader {
  constructor(lines) {
    this.lines = lines;
    this.i = 0;
  }

  // The next line that is not blank or a comment, without consuming it.
  peek() {
    for (; this.i < this.lines.length; this.i++) {
      const line = this.lines[this.i];
      if (line.includes("\t")) fail("tab outside a block scalar");
      const indent = leadingSpaces(line);
      const content = line.slice(indent).replace(/ +$/, "");
      if (content !== "" && !content.startsWith("#")) return { indent, content };
    }
    return null;
  }

  node(indent, depth) {
    if (depth > MAX_DEPTH) fail("nested too deeply");
    return isSeqStart(this.peek().content) ? this.list(indent, depth) : this.map(indent, depth);
  }

  map(indent, depth) {
    const out = Object.create(null);
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) return out;
      if (line.indent > indent) fail("unexpected indentation");
      const match = KEY.exec(line.content);
      if (!match || match[1].length > MAX_KEY_LENGTH) fail("expected `key: value`");
      if (match[1] in out) fail("duplicate key");
      this.i++;
      out[match[1]] = this.value(match[2] ?? "", indent, depth, true);
    }
  }

  list(indent, depth) {
    const out = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) return out;
      if (line.indent > indent) fail("unexpected indentation");
      // A list written flush with its key ends at the next key; the caller checks that line.
      if (!isSeqStart(line.content)) return out;
      const rest = line.content.slice(1);
      const item = rest.replace(/^ +/, "");
      if (isSeqStart(item) || KEY.test(item)) {
        // `- key: value` and `- - x` open a nested block at the column where the item starts.
        const column = indent + 1 + (rest.length - item.length);
        this.lines[this.i] = " ".repeat(column) + item;
        out.push(this.node(column, depth + 1));
      } else {
        this.i++;
        out.push(this.value(item, indent, depth, false));
      }
    }
  }

  // The value after `key:` or `- `. `parentIndent` is the indent of that key or dash.
  value(rest, parentIndent, depth, isMapValue) {
    const text = trimSpaces(rest);
    if (text === "" || text.startsWith("#")) {
      const next = this.peek();
      if (next && next.indent > parentIndent) return this.node(next.indent, depth + 1);
      if (isMapValue && next && next.indent === parentIndent && isSeqStart(next.content)) {
        return this.list(parentIndent, depth + 1);
      }
      return null;
    }
    if (text[0] === "|" || text[0] === ">") {
      const header = BLOCK_HEADER.exec(text);
      if (!header) fail("unsupported block scalar header");
      return this.blockScalar(header[1], header[2], parentIndent);
    }
    return readInline(text);
  }

  blockScalar(style, chomp, parentIndent) {
    const body = [];
    let indent = null;
    let widestLeadingBlank = 0;
    let endedByLine = false;
    for (; this.i < this.lines.length; this.i++) {
      const line = this.lines[this.i];
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
        if (widestLeadingBlank > spaces) fail("blank line indented past the block scalar");
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
      if (body.some((l) => l.startsWith(" ") || l.startsWith("\t"))) fail("unsupported folded scalar");
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

// Returns the document's value: a null-prototype object for a map, an array for a list, or
// null for an empty document. Throws YamlError on anything outside the supported subset.
export function parseYaml(text) {
  if (typeof text !== "string" || !ALLOWED.test(text)) fail("unsupported characters");
  const reader = new Reader(text.split("\n"));
  try {
    const first = reader.peek();
    if (!first) return null;
    const value = reader.node(first.indent, 0);
    if (reader.peek()) fail("unexpected content");
    return value;
  } catch (e) {
    if (e instanceof YamlError) throw e;
    throw new YamlError(String(e && e.message));
  }
}
