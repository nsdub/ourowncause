// Sending email for the human edition, through one small interface. docs/push-channel.md says
// why the provider is a decision for the host; docs/operations.md says how to turn it on.
//
// mailer(env) returns null until MAIL_PROVIDER is set, and then {name, send(messages)}:
//   messages  [{to, subject, text, html, headers}], at most BATCH_MAX
//   returns   [{to, ok, error?}], one per message, in order
// Adapters are written against each provider's documented HTTP API and tested against stubs:
//   postmark  POST https://api.postmarkapp.com/email/batch   (MAIL_API_KEY: a server token)
//   resend    POST https://api.resend.com/emails/batch       (MAIL_API_KEY: an API key)
//   dry-run   sends nothing and reports every message as sent, for trying the routes
// MAIL_FROM is the sender, such as "Our Own Cause <edition@ourowncause.com>", on a domain the
// provider has verified.

export const BATCH_MAX = 100;
const PROVIDERS = ["postmark", "resend", "dry-run"];

const fail = (messages, error) => messages.map((m) => ({ to: m.to, ok: false, error }));

async function postmark(env, messages) {
  const response = await fetch("https://api.postmarkapp.com/email/batch", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-postmark-server-token": env.MAIL_API_KEY },
    body: JSON.stringify(messages.map((m) => ({
      From: env.MAIL_FROM, To: m.to, Subject: m.subject, TextBody: m.text, HtmlBody: m.html,
      MessageStream: m.stream ?? "broadcast",
      Headers: Object.entries(m.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
    }))),
  });
  if (!response.ok) return fail(messages, `postmark answered ${response.status}`);
  const results = await response.json().catch(() => null);
  if (!Array.isArray(results)) return fail(messages, "postmark answered without a result list");
  return messages.map((m, i) => (results[i] && results[i].ErrorCode === 0
    ? { to: m.to, ok: true } : { to: m.to, ok: false, error: String(results[i]?.Message ?? "no result") }));
}

async function resend(env, messages) {
  const response = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: { authorization: `Bearer ${env.MAIL_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(messages.map((m) => ({
      from: env.MAIL_FROM, to: [m.to], subject: m.subject, text: m.text, html: m.html, headers: m.headers ?? {},
    }))),
  });
  if (!response.ok) return fail(messages, `resend answered ${response.status}`);
  const body = await response.json().catch(() => null);
  const data = body && Array.isArray(body.data) ? body.data : null;
  if (!data || data.length !== messages.length) return fail(messages, "resend answered without one id per message");
  return messages.map((m) => ({ to: m.to, ok: true }));
}

export function mailer(env) {
  const name = env && typeof env.MAIL_PROVIDER === "string" ? env.MAIL_PROVIDER.trim().toLowerCase() : "";
  if (!PROVIDERS.includes(name)) return null;
  if (name !== "dry-run" && !(env.MAIL_API_KEY && env.MAIL_FROM)) return null;
  const send = async (messages) => {
    if (messages.length > BATCH_MAX) throw new Error(`at most ${BATCH_MAX} messages in one batch`);
    if (messages.length === 0) return [];
    if (name === "dry-run") return messages.map((m) => ({ to: m.to, ok: true }));
    try {
      return await (name === "postmark" ? postmark(env, messages) : resend(env, messages));
    } catch {
      return fail(messages, `${name} could not be reached`);
    }
  };
  return { name, send };
}
