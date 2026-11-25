// The service that sends the human edition by email and keeps its list of subscribers, behind
// one small interface. docs/push-channel.md says why it is Buttondown; docs/operations.md says
// how it is turned on. The edition itself is ours: the build writes it from the editors'
// committed weekly issue (tools/human_edition.py), and this only hands it over.
//
// newsletter(env) is null until the Pages secret BUTTONDOWN_API_KEY is set, and then:
//   subscribe(email, {referrer})  -> {ok, status}: adds the address as unconfirmed, so that
//                                    Buttondown sends it a confirmation link (double opt-in)
//   findEdition(edition)          -> the Buttondown email already made for this edition, or null
//   sendEdition(edition)          -> {ok, status, id, url, error}: makes the email and sends it to
//                                    every confirmed subscriber
// An edition is {number, slug, subject, markdown, html_url}. Buttondown adds its own
// unsubscribe link and the reason a reader got the email to every message.

export const API = "https://api.buttondown.com/v1";
export const NOT_CONFIGURED = "not configured: the Pages secret BUTTONDOWN_API_KEY is not set";

// The address of an edition's email in Buttondown's archive, and its key there.
export const emailSlug = (edition) => `ourowncause-edition-${String(edition.number).padStart(4, "0")}`;

export function newsletter(env) {
  const key = env && typeof env.BUTTONDOWN_API_KEY === "string" ? env.BUTTONDOWN_API_KEY.trim() : "";
  if (!key) return null;
  const headers = { authorization: `Token ${key}`, accept: "application/json", "content-type": "application/json" };

  async function subscribe(email, { referrer } = {}) {
    const response = await fetch(`${API}/subscribers`, {
      method: "POST",
      // "add" resubscribes an address that unsubscribed earlier, as unconfirmed, with a new
      // confirmation email; an address already subscribed is left as it is.
      headers: { ...headers, "x-buttondown-collision-behavior": "add" },
      body: JSON.stringify({ email_address: email, type: "unactivated", ...(referrer ? { referrer_url: referrer } : {}) }),
    });
    // 400 is also what an address already on the list, or one Buttondown refuses, gets; the
    // person is told the same thing either way.
    return { ok: response.status === 201 || response.status === 200 || response.status === 400, status: response.status };
  }

  async function findEdition(edition) {
    const query = new URLSearchParams({ subject: edition.subject });
    const response = await fetch(`${API}/emails?${query}`, { headers });
    if (!response.ok) throw new Error(`buttondown answered ${response.status} to the list of emails`);
    const page = await response.json();
    const results = Array.isArray(page && page.results) ? page.results : [];
    return results.find((e) => e && e.slug === emailSlug(edition) && e.status !== "deleted") ?? null;
  }

  async function sendEdition(edition) {
    const response = await fetch(`${API}/emails`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        subject: edition.subject,
        body: edition.markdown,
        slug: emailSlug(edition),
        secondary_id: edition.number,
        canonical_url: edition.html_url,
        status: "about_to_send",
        metadata: { ourowncause_edition: String(edition.number) },
      }),
    });
    const data = await response.json().catch(() => null);
    if (response.status !== 201 || !data) {
      return { ok: false, status: response.status, error: String(data?.detail ?? `buttondown answered ${response.status}`).slice(0, 300) };
    }
    return { ok: true, status: data.status ?? null, id: data.id ?? null, url: data.absolute_url ?? null };
  }

  return { name: "buttondown", subscribe, findEdition, sendEdition };
}
