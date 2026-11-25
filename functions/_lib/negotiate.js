// Content negotiation for our HTML pages. Each page the build writes has a markdown twin
// (/posts/<slug>/ and /posts/<slug>.md, and so on). A reader whose Accept header ranks
// text/markdown at least as high as text/html gets the twin at the page's own address; every
// other reader gets the HTML exactly as before. Either way the response says that the twin
// exists (Link) and that the answer depends on Accept (Vary).
//
// Claude Code's WebFetch, for one, sends `Accept: text/markdown, text/html, */*`. Without this
// it would get the HTML and convert it back to markdown, lossily.

const BASE_URL = "https://ourowncause.com";
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

// The path of a page's markdown twin, or null when the path is not one of our pages.
export function twinOf(pathname) {
  if (pathname === "/") return "/index.md";
  if (pathname === "/archive/") return "/archive.md";
  if (pathname === "/questions/") return "/questions/index.md";
  const m = /^\/(posts|questions|issues)\/(.+)\/$/.exec(pathname);
  if (!m || !SLUG.test(m[2]) || m[2].split("/").some((s) => s === "." || s === "..")) return null;
  if (m[1] !== "posts" && m[2].includes("/")) return null;
  return `/${m[1]}/${m[2]}.md`;
}

// Accept parsed into [{type, subtype, q}], in the order given. Malformed ranges are skipped.
export function parseAccept(header) {
  const ranges = [];
  for (const part of String(header || "").split(",")) {
    const [range, ...params] = part.split(";").map((s) => s.trim().toLowerCase());
    const m = /^([a-z0-9!#$%&'*+.^_`|~-]+)\/([a-z0-9!#$%&'*+.^_`|~-]+)$/.exec(range || "");
    if (!m || (m[1] === "*" && m[2] !== "*")) continue;
    let q = 1;
    for (const param of params) {
      const qm = /^q\s*=\s*([0-9.]+)$/.exec(param);
      if (qm) q = Math.min(1, Math.max(0, Number(qm[1]) || 0));
    }
    ranges.push({ type: m[1], subtype: m[2], q });
  }
  return ranges;
}

// The quality a parsed Accept gives one media type: from its most specific matching range
// (type/subtype over type/* over */*), as RFC 9110 says; 0 when nothing matches.
function quality(ranges, type, subtype, { wildcards = true } = {}) {
  let best = -1;
  let q = 0;
  for (const r of ranges) {
    const rank = r.type === type && r.subtype === subtype ? 2
      : wildcards && r.type === type && r.subtype === "*" ? 1
        : wildcards && r.type === "*" ? 0 : -1;
    if (rank > best) {
      best = rank;
      q = r.q;
    } else if (rank === best && rank >= 0) {
      q = Math.max(q, r.q);
    }
  }
  return q;
}

// True when the reader asked for markdown by name and ranks it at least as high as HTML.
// A bare */* (or text/*) is not asking for markdown: browsers send it, and they want HTML.
export function wantsMarkdown(header) {
  const ranges = parseAccept(header);
  const md = Math.max(quality(ranges, "text", "markdown", { wildcards: false }),
    quality(ranges, "text", "x-markdown", { wildcards: false }));
  return md > 0 && md >= quality(ranges, "text", "html");
}

const linkHeader = (twin) => `<${BASE_URL}${twin}>; rel="alternate"; type="text/markdown"`;

function addVary(headers) {
  const vary = headers.get("vary");
  if (!vary) headers.set("vary", "Accept");
  else if (!vary.split(",").some((v) => v.trim().toLowerCase() === "accept")) headers.set("vary", `${vary}, Accept`);
}

// The HTML response, with Vary and, on a page that was found, the Link to its twin.
function marked(response, twin) {
  const out = new Response(response.body, response);
  addVary(out.headers);
  const type = out.headers.get("content-type") || "";
  if (response.status === 200 && type.startsWith("text/html")) out.headers.append("link", linkHeader(twin));
  return out;
}

// The twin, read from the static assets; null when there is none or it cannot be read.
async function readTwin(context, twin) {
  try {
    const response = await context.env.ASSETS.fetch(new URL(twin, context.request.url));
    if (response.status !== 200) return null;
    const text = await response.text();
    // A path with no file can come back as an HTML page (the 404 page, or the front page on a
    // build without one); that is not a twin.
    if (/^\s*<(?:!doctype|html)\b/i.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

export async function negotiate(context) {
  const { request } = context;
  const twin = (request.method === "GET" || request.method === "HEAD")
    ? twinOf(new URL(request.url).pathname) : null;
  if (twin === null) return context.next();
  if (wantsMarkdown(request.headers.get("accept")) && context.env && context.env.ASSETS) {
    const text = await readTwin(context, twin);
    if (text !== null) {
      return new Response(request.method === "HEAD" ? null : text, { status: 200, headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-location": twin,
        "vary": "Accept",
        // The page's own address stays the canonical one for this markdown answer.
        "link": `${linkHeader(twin)}, <${BASE_URL}${new URL(request.url).pathname}>; rel="canonical"`,
        "x-content-type-options": "nosniff",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=0, must-revalidate",
      } });
    }
  }
  return marked(await context.next(), twin);
}
