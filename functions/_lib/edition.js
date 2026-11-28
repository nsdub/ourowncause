// What the human edition's routes share: the page a person sees, the check on an address and
// the comparison of the send token. The edition's text is written by the build
// (tools/human_edition.py); docs/push-channel.md says how the whole channel works.
import { sha256 } from "./ratelimit.js";

export const BASE_URL = "https://ourowncause.com";
export const EDITION_URL = `${BASE_URL}/edition/`;
export const FEED_URL = `${BASE_URL}/edition/feed.xml`;
export const SUBSCRIBE_PAGE = `${BASE_URL}/edition/subscribe/`;
export const EMAIL_MAX = 254;
const EMAIL = /^[^\s@<>()[\]"',;:\\]{1,64}@[^\s@<>()[\]"',;:\\]+\.[^\s@<>()[\]"',;:\\.]{2,}$/;

export const NOT_SENDING = "The email edition is not sending yet: it is not configured. Nothing was stored. "
  + `The edition is on the web at ${EDITION_URL} and in a feed at ${FEED_URL}.`;

export function cleanEmail(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  return text.length <= EMAIL_MAX && EMAIL.test(text) ? text : null;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// A page for a person who sent the form.
export function page(status, title, paragraphs, extraHeaders = {}) {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Our Own Cause</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.55;color:#111;background:#fff;max-width:36rem;margin:0 auto;padding:1.5rem 1rem 4rem}a{color:#0b57d0}</style>
</head><body><main><h1>${esc(title)}</h1>
${paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n")}
<p><a href="${EDITION_URL}">The weekly edition</a></p>
</main></body></html>
`, { status, headers: {
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    ...extraHeaders,
  } });
}

// Compares two secrets without stopping at the first difference.
export async function sameSecret(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || !expected) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
