// GET /.well-known/mcp.json: the MCP server card (also at /mcp/server-card).
import { cardHandler } from "../_lib/mcp-card.js";

export const onRequest = cardHandler("application/json; charset=utf-8");
