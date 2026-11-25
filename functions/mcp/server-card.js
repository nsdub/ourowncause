// GET /mcp/server-card: the MCP server card at the location SEP-2127 reserves, in the Server
// Card media type. The same card is at /.well-known/mcp.json.
import { cardHandler } from "../_lib/mcp-card.js";

export const onRequest = cardHandler("application/mcp-server-card+json; charset=utf-8");
