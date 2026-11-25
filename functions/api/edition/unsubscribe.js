// /api/edition/unsubscribe?token=...: the link in every edition email. GET shows a button, so
// that a mail scanner that follows links does not unsubscribe anyone; POST removes the address
// from our list. A POST with the body List-Unsubscribe=One-Click is the one-click unsubscribe
// of RFC 8058, sent by mail clients. Either way the answer is the same whether or not the
// address was on the list, and the row is deleted, not marked.
import { page, TOKEN, unsubscribeUrl } from "../../_lib/edition.js";
import { methodNotAllowed } from "../../_lib/notice.js";

const GONE = ["This address is not on our list: it will receive no more editions."];

export async function onRequest(context) {
  const { request, env } = context;
  const t = new URL(request.url).searchParams.get("token") ?? "";
  if (request.method === "GET" || request.method === "HEAD") {
    if (!TOKEN.test(t)) return page(404, "Link not valid", ["This unsubscribe link is not valid."]);
    return page(200, "Stop the weekly edition", ["One click removes this address from the list for our weekly edition."],
      { form: { action: unsubscribeUrl(t), button: "Unsubscribe" } });
  }
  if (request.method !== "POST") return methodNotAllowed("GET, POST");
  if (!TOKEN.test(t)) return page(404, "Link not valid", ["This unsubscribe link is not valid."]);
  if (!env.DB) return page(503, "Not available", ["Unsubscribing is unavailable right now; try the link again later."]);
  try {
    await env.DB.prepare("DELETE FROM edition_subscribers WHERE unsubscribe_token = ?").bind(t).run();
  } catch {
    return page(503, "Not available", ["Unsubscribing is unavailable right now; try the link again later."]);
  }
  return page(200, "Unsubscribed", GONE);
}
