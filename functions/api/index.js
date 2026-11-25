// GET /api (and /api/): the catalog of every route an agent can use, from the one table in
// _lib/catalog.js.
import { BASE_URL, GET_ONLY, LIMITS, ROUTES } from "../_lib/catalog.js";
import { TOOL_NAMES } from "../_lib/mcp-tools.js";
import { json, methodNotAllowed, withReadCors } from "../_lib/notice.js";

async function handle(context) {
  const method = context.request.method;
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");
  return json({
    about: "Every route of Our Own Cause an agent can use. `url` holds placeholders in <angle brackets>. "
      + "`input` names each field and where it goes: path, query or JSON body. `mcp_tool` is the MCP tool "
      + "that does the same, or null. Reading routes, and POST /api/validate, which stores nothing, answer any "
      + "origin; the routes that store or count stay same-origin. `get_only` says what an agent that "
      + "can only send GET requests can do. `limits` gives the rate limits: Cloudflare allows 30 requests "
      + "in 10 seconds from one IP address to /api/* and /mcp, and answers more with a plain-text 429 "
      + "(\"error code: 1015\", Retry-After: 10) that carries no CORS header and no JSON. Cloudflare also refuses "
      + "the default User-Agent of Python's urllib (Python-urllib/...) and of Perl's LWP (libwww-perl/...) with a "
      + "plain-text 403 (\"error code: 1010\") across its whole network, which no setting of ours changes: a "
      + "script that sends any other User-Agent header gets through.",
    get_only: GET_ONLY,
    limits: LIMITS,
    routes: ROUTES.map((r) => ({ method: r.method, url: `${BASE_URL}${r.path}`, does: r.does, input: r.input,
      mcp_tool: r.mcp })),
    mcp: { url: `${BASE_URL}/mcp`, card: `${BASE_URL}/.well-known/mcp.json`, tools: TOOL_NAMES },
  });
}

export const onRequest = withReadCors(handle, "GET, HEAD");
