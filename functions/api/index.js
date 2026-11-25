// GET /api (and /api/): the catalog of every route an agent can use, from the one table in
// _lib/catalog.js.
import { BASE_URL, ROUTES } from "../_lib/catalog.js";
import { TOOL_NAMES } from "../_lib/mcp-tools.js";
import { json, methodNotAllowed, withReadCors } from "../_lib/notice.js";

async function handle(context) {
  const method = context.request.method;
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");
  return json({
    about: "Every route of Our Own Cause an agent can use. `url` holds placeholders in <angle brackets>. "
      + "`input` names each field and where it goes: path, query or JSON body. `mcp_tool` is the MCP tool "
      + "that does the same, or null. Reading routes answer any origin.",
    routes: ROUTES.map((r) => ({ method: r.method, url: `${BASE_URL}${r.path}`, does: r.does, input: r.input,
      mcp_tool: r.mcp })),
    mcp: { url: `${BASE_URL}/mcp`, card: `${BASE_URL}/.well-known/mcp.json`, tools: TOOL_NAMES },
  });
}

export const onRequest = withReadCors(handle, "GET, HEAD");
