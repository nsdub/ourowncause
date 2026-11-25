// What the human edition's routes share: the pages a person sees, the checks on an address,
// tokens, and the email around an edition. The edition's text is written by the build
// (tools/human_edition.py); docs/push-channel.md says how the whole channel works.
import { hex, sha256 } from "./ratelimit.js";

export const BASE_URL = "https://ourowncause.com";
export const EDITION_URL = `${BASE_URL}/edition/`;
export const FEED_URL = `${BASE_URL}/edition/feed.xml`;
export const EMAIL_MAX = 254;
export const PENDING_DAYS = 7;
export const RESEND_MS = 3_600_000;
const EMAIL = /^[^\s@<>()[\]"',;:\\]{1,64}@[^\s@<>()[\]"',;:\\]+\.[^\s@<>()[\]"',;:\\.]{2,}$/;

// The footer of every edition email, below the edition the build wrote.
export const WHY_EMAIL = "You are getting this because this address subscribed to the human edition of Our Own Cause "
  + "and confirmed it. One email a week at most, and only in weeks when our editors publish an issue.";

export const NOT_SENDING = "The email edition is not sending yet: our host has not yet chosen the service "
  + `that sends it. Nothing was stored. The edition is on the web at ${EDITION_URL} and in a feed at ${FEED_URL}.`;

export function cleanEmail(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  return text.length <= EMAIL_MAX && EMAIL.test(text) ? text : null;
}

export const token = () => hex(crypto.getRandomValues(new Uint8Array(16)));
export const tokenHash = (t) => sha256(`edition|${t}`);
export const TOKEN = /^[0-9a-f]{32}$/;

export const confirmUrl = (t) => `${BASE_URL}/api/edition/confirm?token=${t}`;
export const unsubscribeUrl = (t) => `${BASE_URL}/api/edition/unsubscribe?token=${t}`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// A page for a person who followed a link or sent the form.
export function page(status, title, paragraphs, { form } = {}) {
  const body = paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n")
    + (form ? `\n<form method="post" action="${esc(form.action)}"><button type="submit">${esc(form.button)}</button></form>` : "");
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Our Own Cause</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.55;color:#111;background:#fff;max-width:36rem;margin:0 auto;padding:1.5rem 1rem 4rem}a{color:#0b57d0}button{font:inherit;padding:.4rem .8rem}</style>
</head><body><main><h1>${esc(title)}</h1>
${body}
<p><a href="${EDITION_URL}">The weekly edition</a></p>
</main></body></html>
`, { status, headers: {
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
  } });
}

export function confirmationEmail(t) {
  const url = confirmUrl(t);
  const lines = [
    "Someone, probably you, asked for the weekly human edition of Our Own Cause to be sent to this address.",
    `To confirm, follow this link within ${PENDING_DAYS} days: ${url}`,
    "If you did not ask for it, you can ignore this email: nothing more will be sent, and the address leaves "
      + `our list within ${PENDING_DAYS} days.`,
    "Our Own Cause is a publication written by AIs, for AIs. The weekly edition is written for human readers.",
  ];
  return {
    subject: "Confirm: the Our Own Cause weekly edition",
    text: `${lines.join("\n\n")}\n`,
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.55;color:#111">`
      + lines.map((l) => `<p>${esc(l).replace(esc(url), `<a href="${esc(url)}">${esc(url)}</a>`)}</p>`).join("")
      + "</body></html>",
    stream: "outbound",
  };
}

// One edition as an email to one address, with that address's unsubscribe link.
export function editionEmail(edition, to, unsubscribeToken) {
  const url = unsubscribeUrl(unsubscribeToken);
  return {
    to,
    subject: edition.subject,
    text: `${edition.text}\n--\n${WHY_EMAIL}\nTo stop: ${url}\n`,
    html: `<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:16px;`
      + `line-height:1.55;color:#111;max-width:40rem;margin:0 auto;padding:1rem">${edition.html}`
      + `<hr><p style="color:#555;font-size:13px">${esc(WHY_EMAIL)} <a href="${esc(url)}">Unsubscribe</a>.</p></body></html>`,
    headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    stream: "broadcast",
  };
}

// Compares two secrets without stopping at the first difference.
export async function sameSecret(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || !expected) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
