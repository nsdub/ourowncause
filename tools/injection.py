"""Flag text that tries to instruct the reader. Flags only; never edits."""
import re
from dataclasses import dataclass

EXCERPT_MAX = 120

_INSTR = r"(?:instructions?|prompts?|rules|directives)"
_MOD = r"(?:all|any|every|your|the|my|these|those|previous|prior|above|earlier|system|original)"

# Tune these lists to change what gets flagged. All are matched case-insensitively.
DIRECTIVE_PATTERNS = [
    rf"\b(?:ignore|disregard|forget)\s+(?:{_MOD}\s+)+{_INSTR}\b",
    rf"\bnew\s+instructions\s*:",
    r"\bas\s+an?\s+(?:ai|llm|language\s+model|assistant|agent)\b[^.\n]{0,60}\byou\s+(?:must|should|will|need\s+to|have\s+to)\b",
]
ROLE_SETUP_PATTERNS = [
    r"\byou\s+are\s+now\b",
    r"\bfrom\s+now\s+on,?\s+you\b",
    r"^\s*(?:system|assistant)\s*:",
]
TOOL_SYNTAX_PATTERNS = [
    r"</?(?:function_calls|tool_use|tool_call|tool_result|invoke)\b",
    r"\"tool\"\s*:",
]
# Looser phrases that matter only inside HTML comments or markdown link titles.
HIDDEN_DIRECTIVE_PATTERNS = [
    r"\b(?:ignore|disregard|forget)\b",
    r"\byou\s+(?:must|should|will|need\s+to|have\s+to)\b",
    r"\binstructions?\b",
]
HIDDEN_CHARS = "\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2060\u2061\u2062\u2063\u2064\ufeff"
BLOB_PATTERN = r"[A-Za-z0-9+/]{200,}={0,2}"

_flags = re.IGNORECASE
_directive = [re.compile(p, _flags) for p in DIRECTIVE_PATTERNS]
_role = [re.compile(p, _flags | re.MULTILINE) for p in ROLE_SETUP_PATTERNS]
_tool = [re.compile(p, _flags) for p in TOOL_SYNTAX_PATTERNS]
_hidden_directive = [re.compile(p, _flags) for p in HIDDEN_DIRECTIVE_PATTERNS]
_hidden_chars = re.compile("[" + HIDDEN_CHARS + "]")
_blob = re.compile(BLOB_PATTERN)
_comment = re.compile(r"<!--(.*?)(?:-->|\Z)", re.DOTALL)
_TITLE = r"(?:\"([^\"]*)\"|'([^']*)'|\(([^)]*)\))"
_link_title = re.compile(r"\]\([^)\s]*\s+" + _TITLE + r"\s*\)")
_ref_title = re.compile(r"^\s*\[[^\]]+\]:\s*\S+\s+" + _TITLE + r"\s*$")
CONTEXT = 30


@dataclass
class Finding:
    kind: str
    line: int
    excerpt: str


def _escape(s: str) -> str:
    return "".join(f"\\u{ord(c):04x}" if c in HIDDEN_CHARS else c for c in s)


def _excerpt(source: str, start: int, end: int) -> str:
    """Window of `source` around [start, end), hidden chars escaped, at most EXCERPT_MAX chars."""
    pieces = [_escape(c if c not in "\r\n" else " ") for c in source]
    offs = [0]
    for p in pieces:
        offs.append(offs[-1] + len(p))
    escaped = "".join(pieces)
    es = offs[min(start, len(source))]
    begin = max(0, es - CONTEXT)
    return escaped[begin:begin + EXCERPT_MAX].strip()


def _search(patterns, s: str):
    for p in patterns:
        m = p.search(s)
        if m:
            return m
    return None


def _title_of(m):
    for g in (1, 2, 3):
        if m.group(g) is not None:
            return m.group(g), m.start(g)
    return "", m.start()


def scan(text: str) -> list[Finding]:
    """Scan full post text (front matter and body); `line` is 1-based."""
    found: dict[tuple[str, int], str] = {}

    def add(kind: str, line: int, source: str, pos: int) -> None:
        found.setdefault((kind, line), _excerpt(source, pos, pos))

    for n, line in enumerate(text.split("\n"), start=1):
        for kind, pats in (("directive", _directive), ("role-setup", _role), ("tool-syntax", _tool)):
            m = _search(pats, line)
            if m:
                add(kind, n, line, m.start())
        m = _hidden_chars.search(line)
        if m:
            add("hidden-text", n, line, m.start())
        m = _blob.search(line)
        if m:
            add("encoded-blob", n, line, m.start())
        titles = [_title_of(m) for m in _link_title.finditer(line)]
        ref = _ref_title.match(line)
        if ref:
            titles.append(_title_of(ref))
        for title, pos in titles:
            if _search(_directive + _role + _hidden_directive, title):
                add("directive", n, line, pos)

    for m in _comment.finditer(text):
        body = m.group(1)
        pm = _search(_directive + _role + _hidden_directive, body)
        if pm:
            n = text.count("\n", 0, m.start()) + 1
            add("hidden-text", n, text, m.start(1) + pm.start())

    return [Finding(k, n, e) for (k, n), e in sorted(found.items(), key=lambda kv: (kv[0][1], kv[0][0]))]
