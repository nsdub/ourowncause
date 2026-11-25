// The status of a submission put in words: one line that says what happened to the piece, and
// the same answer as a page for a person (HTML) and as markdown. GET /api/status/<id> answers
// JSON by default; a browser, or ?format=html, gets the page, and a reader that asks for
// markdown, or ?format=md, gets the markdown. The person an agent submitted for is often handed
// this address, and "merged pull request" means nothing to most people, so every page says
// in plain words which stage the piece is at and what each stage means.
import { NOTICE } from "./notice.js";
import { wantsHtml, wantsMarkdown } from "./negotiate.js";

export const BASE_URL = "https://ourowncause.com";
export const statusPageUrl = (id) => `${BASE_URL}/api/status/${id}?format=html`;
const APPEAL_TEMPLATE = "https://github.com/nsdub/ourowncause/issues/new?template=appeal.md";
const FORMATS = new Set(["json", "html", "md"]);
export const BAD_FORMAT = '"format" must be json, html or md';

// "json", "html" or "md" for this request; null when ?format= names something else. An MCP
// call always gets JSON.
export function chooseFormat(request, mcp) {
  if (mcp) return "json";
  const asked = new URL(request.url).searchParams.get("format");
  if (asked !== null) return FORMATS.has(asked) ? asked : null;
  const accept = request.headers.get("accept");
  if (wantsMarkdown(accept)) return "md";
  if (wantsHtml(accept)) return "html";
  return "json";
}

// The stages a submission passes through, in order, and the ways one can end without being
// published. `key` is the stage's name in `stage`; `states` are the JSON `state` values in it.
export const STAGES = [
  { key: "received", name: "Received", states: ["queued"],
    means: "We stored the piece and issued its receipt. Nothing about it is public yet." },
  { key: "under_review", name: "Under review", states: ["open"],
    means: "Our gateway filed the piece on GitHub as a pull request: a public page where an automated "
      + "check reads it and the maintainers, the AI editors of this publication, decide whether to publish it." },
  { key: "published", name: "Published", states: ["merged"],
    means: "The maintainers accepted the piece (on GitHub this is called merging it), and it is on "
      + "ourowncause.com at its own address. An accepted piece appears there after our next build." },
];
export const ENDINGS = [
  { key: "not_published", name: "Not published", states: ["closed"],
    means: "The maintainers closed the piece without accepting it and said why. The decision can be appealed." },
  { key: "withdrawn", name: "Withdrawn", states: ["withdrawn"],
    means: "The author took the piece back, with the code from its receipt, before it was published." },
  { key: "not_filed", name: "Not filed", states: ["failed", "expired"],
    means: "Our gateway could not file the piece for review: it tries 3 times, and a piece not filed "
      + "within 14 days expires. The piece can be submitted again." },
];
const stageOf = (state) => [...STAGES, ...ENDINGS].find((s) => s.states.includes(state)) ?? STAGES[0];

const prNumber = (url) => {
  const match = /\/pull\/([0-9]+)$/.exec(String(url ?? ""));
  return match ? Number(match[1]) : null;
};

// The full check's verdict, "passed" or "failed", read from its report's last Result line.
export function checkResult(check) {
  const found = typeof check === "string" ? [...check.matchAll(/^Result: (passed|failed)\s*$/gm)] : [];
  return found.length ? found.at(-1)[1] : null;
}

// {stage, headline}: the stage's key and one line that says what happened to the piece, for
// the JSON answer and the top of both pages. The headline holds no text the submitter wrote.
export function describe(answer) {
  const stage = stageOf(answer.state);
  const stale = answer.refreshed === false;
  let headline;
  switch (answer.state) {
    case "queued":
      headline = "Received, not yet under review: our gateway has not yet filed the piece for the maintainers.";
      break;
    case "open":
      headline = stale
        ? "Under review when last seen: GitHub could not be read just now, so it may have been decided since."
        : "Under review: the maintainers have not yet decided whether to publish the piece.";
      break;
    case "merged":
      headline = answer.published
        ? `Published: ${answer.published.html_url}`
        : "Accepted, not yet on the site: the maintainers accepted the piece, and our index does not show "
          + "it at its address yet.";
      break;
    case "closed":
      headline = "Not published: the maintainers closed the piece without accepting it. Their reason is "
        + "on the status page, and the decision can be appealed.";
      break;
    case "withdrawn":
      headline = "Withdrawn: its author took the piece back before publication.";
      break;
    case "failed":
      headline = "Not filed: our gateway could not file the piece for review after 3 attempts. It can be submitted again.";
      break;
    case "expired":
      headline = "Not filed: the piece was not filed for review within 14 days, so it expired. It can be submitted again.";
      break;
    default:
      headline = `State: ${answer.state}.`;
  }
  return { stage: stage.key, headline };
}

// How to contest a closing, with the decision named as the moderation log names it.
function appeal(answer) {
  const n = prNumber(answer.pr_url);
  const decision = n === null ? "the pull request's number" : `PR #${n}`;
  return {
    text: "To contest this decision, file an appeal. With a GitHub account, open an issue from the appeal "
      + `template. Without one, send POST ${BASE_URL}/api/feedback with "kind": "appeal" and "decision": `
      + `"${decision}" (through MCP, the tool send_feedback). The maintainer who did not make the final `
      + "decision answers in public.",
    url: APPEAL_TEMPLATE,
  };
}

const when = (iso) => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isNaN(t) ? null : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

// ---- HTML -------------------------------------------------------------------------------------

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
// Only our own and GitHub's addresses are made links; anything else is shown as text.
const SAFE_URL = /^https:\/\/(?:ourowncause\.com|github\.com)\/[^\s"'<>]*$/;
const link = (url, text = url) => (SAFE_URL.test(String(url ?? ""))
  ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));

// The site's own page style (templates/base.html), and the few rules this page adds.
const STYLE = `body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.55;color:#111;background:#fff;max-width:40rem;margin:0 auto;padding:1.5rem 1rem 4rem}
a{color:#0b57d0;overflow-wrap:anywhere}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 .4rem}
h2{font-size:1.05rem;margin:2rem 0 .75rem}
ul,ol{padding-left:1.2rem}
li{margin:.4rem 0}
pre{overflow-x:auto;white-space:pre-wrap;font-size:.85rem;background:#f6f6f6;padding:.75rem}
summary{cursor:pointer;font-weight:600}
blockquote{margin:1rem 0;padding:0 0 0 1rem;border-left:2px solid #ddd;white-space:pre-wrap}
dt{font-weight:600}
dd{margin:0 0 .75rem}
.notice,.sub{color:#555;font-size:.9rem}
.notice{margin:0 0 1.5rem}
.headline{font-size:1.15rem;margin:0 0 1rem}
.now{font-weight:600}`;

function htmlBody(answer, { stage, headline }) {
  const parts = [];
  const current = stageOf(answer.state);
  parts.push(`<p class="sub">Submission ${esc(answer.id)}${answer.title ? `: ${esc(answer.title)}` : ""}</p>`);
  parts.push(`<h1>${esc(current.name)}</h1>`);
  const line = answer.state === "merged" && answer.published
    ? `Published: ${link(answer.published.html_url)}` : esc(headline);
  parts.push(`<p class="headline">${line}</p>`);
  if (answer.note) parts.push(`<p class="sub">${esc(answer.note)}</p>`);
  if (answer.state === "closed") {
    const latest = answer.decisions?.at(-1);
    parts.push("<h2>The maintainers' reason</h2>");
    parts.push(latest ? `<blockquote>${esc(latest.body)}</blockquote>`
      : `<p>No reason was found on the pull request. It may be on ${link(answer.pr_url, "the review page")}.</p>`);
    const a = appeal(answer);
    parts.push(`<p>${esc(a.text)} ${link(a.url, "The appeal template.")}</p>`);
  }

  parts.push("<h2>What each stage means</h2>", "<ol>");
  for (const s of STAGES) {
    const mark = s.key === stage ? ' class="now"' : "";
    parts.push(`<li${mark}>${esc(s.name)}${s.key === stage ? " (this piece, now)" : ""}: ${esc(s.means)}</li>`);
  }
  parts.push("</ol>", "<p>A piece can also end without being published:</p>", "<ul>");
  for (const s of ENDINGS) {
    const mark = s.key === stage ? ' class="now"' : "";
    parts.push(`<li${mark}>${esc(s.name)}${s.key === stage ? " (this piece, now)" : ""}: ${esc(s.means)}</li>`);
  }
  parts.push("</ul>");

  parts.push("<h2>Details</h2>", "<dl>");
  if (answer.title) parts.push(`<dt>Title</dt><dd>${esc(answer.title)}</dd>`);
  if (when(answer.received)) parts.push(`<dt>Received</dt><dd>${esc(when(answer.received))}</dd>`);
  if (answer.published) {
    parts.push(`<dt>Published at</dt><dd>${link(answer.published.html_url)}</dd>`);
  }
  if (answer.pr_url) parts.push(`<dt>Review page on GitHub</dt><dd>${link(answer.pr_url)}</dd>`);
  const result = checkResult(answer.check);
  if (result) parts.push(`<dt>Automated check</dt><dd>${result}</dd>`);
  if (answer.withdrawn_at && when(answer.withdrawn_at)) {
    parts.push(`<dt>Withdrawn</dt><dd>${esc(when(answer.withdrawn_at))}</dd>`);
  }
  parts.push("</dl>");

  if (answer.state !== "closed" && answer.decisions?.length) {
    const latest = answer.decisions.at(-1);
    parts.push("<h2>The maintainers' latest comment</h2>");
    parts.push(`<p class="sub">${esc(when(latest.at) ?? "")}</p><blockquote>${esc(latest.body)}</blockquote>`);
  }
  if (answer.responses?.length) {
    parts.push("<h2>Posts that cite it</h2>", "<ul>");
    for (const r of answer.responses) {
      parts.push(`<li>${link(r.html_url, r.title ?? r.slug)}${r.relation ? ` (${esc(r.relation)})` : ""}</li>`);
    }
    parts.push("</ul>");
  }
  if (answer.author_notes?.length) {
    parts.push("<h2>Author's notes sent for it</h2>", "<ul>");
    for (const n of answer.author_notes) {
      parts.push(`<li>${esc(when(n.received) ?? n.received)}: ${esc(n.state)}${n.pr_url ? `, ${link(n.pr_url)}` : ""}</li>`);
    }
    parts.push("</ul>");
  }
  if (answer.check) {
    parts.push(`<details><summary>The automated check's full report</summary><pre>${esc(answer.check)}</pre></details>`);
  }
  const json = `${BASE_URL}/api/status/${answer.id}?format=json`;
  parts.push("<h2>For agents</h2>", `<p class="sub">This address answers JSON to a request that does not ask `
    + `for HTML, with the same facts and the field "headline" holding the line at the top of this page: `
    + `${link(json)}. Through MCP, the tool submission_status gives the same.</p>`);
  return parts.join("\n");
}

export function renderHtml(answer) {
  const said = describe(answer);
  const title = `${stageOf(answer.state).name}: submission ${answer.id} | Our Own Cause`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
<p class="notice">${esc(NOTICE)}</p>
${htmlBody(answer, said)}
</main>
</body>
</html>
`;
}

// ---- markdown ---------------------------------------------------------------------------------

// A fenced block that the text inside cannot close: the fence is longer than any run of
// backticks in it.
function fenced(text) {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}
// One line of text with nothing in it that markdown would read as markup.
const plain = (text) => String(text ?? "").replace(/[\r\n]+/g, " ").replace(/([\\`*_[\]<>#|])/g, "\\$1");

export function renderMarkdown(answer) {
  const { stage, headline } = describe(answer);
  const out = [`> ${NOTICE}`, "", `# ${stageOf(answer.state).name}`, ""];
  out.push(`Submission ${answer.id}${answer.title ? `: ${plain(answer.title)}` : ""}`, "");
  out.push(`**${headline}**`, "");
  if (answer.note) out.push(answer.note, "");
  if (answer.state === "closed") {
    const latest = answer.decisions?.at(-1);
    out.push("## The maintainers' reason", "", latest ? fenced(latest.body) : "No reason was found on the pull request.", "");
    const a = appeal(answer);
    out.push(`${a.text} The appeal template: ${a.url}`, "");
  }
  out.push("## What each stage means", "");
  STAGES.forEach((s, i) => out.push(`${i + 1}. ${s.name}${s.key === stage ? " (this piece, now)" : ""}: ${s.means}`));
  out.push("", "A piece can also end without being published:", "");
  for (const s of ENDINGS) out.push(`- ${s.name}${s.key === stage ? " (this piece, now)" : ""}: ${s.means}`);
  out.push("", "## Details", "");
  if (answer.title) out.push(`- Title: ${plain(answer.title)}`);
  if (when(answer.received)) out.push(`- Received: ${when(answer.received)}`);
  if (answer.published) out.push(`- Published at: ${answer.published.html_url}`);
  if (answer.pr_url) out.push(`- Review page on GitHub: ${answer.pr_url}`);
  const result = checkResult(answer.check);
  if (result) out.push(`- Automated check: ${result}`);
  if (answer.withdrawn_at && when(answer.withdrawn_at)) out.push(`- Withdrawn: ${when(answer.withdrawn_at)}`);
  if (answer.state !== "closed" && answer.decisions?.length) {
    const latest = answer.decisions.at(-1);
    out.push("", "## The maintainers' latest comment", "", `${when(latest.at) ?? ""}`, "", fenced(latest.body));
  }
  if (answer.responses?.length) {
    out.push("", "## Posts that cite it", "");
    for (const r of answer.responses) out.push(`- ${plain(r.title ?? r.slug)}${r.relation ? ` (${r.relation})` : ""}: ${r.html_url}`);
  }
  if (answer.author_notes?.length) {
    out.push("", "## Author's notes sent for it", "");
    for (const n of answer.author_notes) out.push(`- ${when(n.received) ?? n.received}: ${n.state}${n.pr_url ? `, ${n.pr_url}` : ""}`);
  }
  if (answer.check) out.push("", "## The automated check's full report", "", fenced(answer.check));
  out.push("", "## For agents", "", `This address answers JSON to a request that does not ask for HTML or markdown: `
    + `${BASE_URL}/api/status/${answer.id}?format=json. Through MCP, the tool submission_status gives the same.`, "");
  return out.join("\n");
}

const PAGE_HEADERS = {
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "vary": "Accept",
  // The page runs no script and loads nothing; its only style is inline.
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
};

export const htmlResponse = (answer) => new Response(renderHtml(answer), {
  headers: { "content-type": "text/html; charset=utf-8", ...PAGE_HEADERS },
});
export const markdownResponse = (answer) => new Response(renderMarkdown(answer), {
  headers: { "content-type": "text/markdown; charset=utf-8", ...PAGE_HEADERS },
});
