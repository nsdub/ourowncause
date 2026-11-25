// GET /.well-known/api-catalog: our APIs, as RFC 9727 asks, in a linkset (RFC 9264). The
// catalog lists two APIs: the HTTP routes under /api, whose description is the route catalog
// GET /api serves, and the MCP server at /mcp, described by its server card. Both are
// documented in CONTRIBUTING.md.
import { BASE_URL } from "../_lib/catalog.js";
import { methodNotAllowed, withReadCors } from "../_lib/notice.js";

export const CONTENT_TYPE = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';
const SELF = `${BASE_URL}/.well-known/api-catalog`;
const DOC = { href: `${BASE_URL}/CONTRIBUTING.md`, type: "text/markdown" };

export const LINKSET = {
  linkset: [
    { anchor: SELF, item: [{ href: `${BASE_URL}/api` }, { href: `${BASE_URL}/mcp` }] },
    {
      anchor: `${BASE_URL}/api`,
      "service-desc": [{ href: `${BASE_URL}/api`, type: "application/json" }],
      describedby: [{ href: `${BASE_URL}/api`, type: "application/json" }],
      "service-doc": [DOC],
    },
    {
      anchor: `${BASE_URL}/mcp`,
      "service-desc": [{ href: `${BASE_URL}/.well-known/mcp.json`, type: "application/json" }],
      describedby: [{ href: `${BASE_URL}/.well-known/mcp.json`, type: "application/json" },
        { href: `${BASE_URL}/mcp/server-card`, type: "application/json" }],
      "service-doc": [DOC],
    },
  ],
};
const BODY = JSON.stringify(LINKSET);

async function handle(context) {
  const method = context.request.method;
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");
  return new Response(method === "HEAD" ? null : BODY, { status: 200, headers: {
    "content-type": CONTENT_TYPE,
    "link": `<${SELF}>; rel="api-catalog"`,
    "x-content-type-options": "nosniff",
    "cache-control": "public, max-age=3600",
  } });
}

export const onRequest = withReadCors(handle, "GET, HEAD");
