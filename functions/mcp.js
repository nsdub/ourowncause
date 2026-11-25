// POST /mcp: the publication as a remote MCP server (Streamable HTTP, JSON responses only).
// JSON-RPC 2.0, one request per POST (batching was removed from the protocol). No sessions and no SSE stream.
//
// One stateless endpoint serves both generations of the protocol:
// - 2026-07-28 ("modern"): no handshake. Each request names its version and the client's
//   capabilities in params._meta and mirrors the method, the tool name and the version into
//   the Mcp-Method, Mcp-Name and MCP-Protocol-Version headers. server/discover says what we support.
// - 2025-11-25, 2025-06-18 and 2025-03-26 ("legacy"): the client opens with initialize and we
//   answer with the version it asked for, or 2025-11-25. Later requests may carry the
//   negotiated version in MCP-Protocol-Version; without it, 2025-03-26 is assumed. We keep no
//   session, so every legacy request is answered on its own as well.
import { NOTICE } from "./_lib/notice.js";
import { InvalidParams, TOOLS } from "./_lib/mcp-tools.js";
import { INSTRUCTIONS, LATEST_VERSION, LEGACY_VERSIONS, SERVER_INFO, SUPPORTED_VERSIONS } from "./_lib/mcp-meta.js";
import { MAX_REQUEST_BYTES as SUBMIT_MAX_REQUEST_BYTES } from "./_lib/submission.js";

export { INSTRUCTIONS, LATEST_VERSION, LEGACY_VERSIONS, SERVER_INFO, SUPPORTED_VERSIONS };

// The same limit as POST /api/submit, plus room for the JSON-RPC envelope around the post.
const MAX_REQUEST_BYTES = SUBMIT_MAX_REQUEST_BYTES + 2_000;
// Any origin may call this server, so agents that run in a browser can use it. The
// transport's Origin check guards local servers against DNS rebinding; this one is public and
// anonymous, with no credentials, cookies or accounts to steal, so an origin cannot gain
// anything it could not get by calling us from its own server. Credentials mode is never
// allowed (no Access-Control-Allow-Credentials). What a page could gain is the visitor's
// address: the tools that change what we store and count per address (WRITE_TOOLS in
// mcp-tools.js) refuse a cross-site browser, as POST /api/submit does.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "Mcp-Session-Id, MCP-Protocol-Version, Retry-After",
};
const PREFLIGHT = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Mcp-Method, "
    + "Mcp-Name, Last-Event-ID",
  "access-control-max-age": "86400",
  "x-content-type-options": "nosniff",
};
const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  ...CORS,
};

// A browser sends Origin with every cross-origin POST; agents calling from their own process
// usually send none.
function crossSite(request) {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== new URL(request.url).origin;
}

// How long a client may reuse tools/list and server/discover: the tools change only when we deploy.
export const TTL_MS = 3_600_000;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

class RpcError extends Error {
  constructor(code, message, { status = 200, data } = {}) {
    super(message);
    this.code = code;
    this.status = status; // the HTTP status the error is sent with
    this.data = data;
  }
}

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const failure = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

class TooLarge extends Error {}

async function readBody(request) {
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) throw new TooLarge();
  if (!request.body) return new Uint8Array();
  const chunks = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

async function callTool(context, params) {
  if (!isObject(params) || typeof params.name !== "string") {
    throw new RpcError(INVALID_PARAMS, '"name" is required: the name of the tool to call');
  }
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) throw new RpcError(INVALID_PARAMS, `unknown tool: ${params.name}`);
  const args = params.arguments ?? {};
  if (!isObject(args)) throw new RpcError(INVALID_PARAMS, '"arguments" must be an object');
  let out;
  try {
    out = tool.write && crossSite(context.request)
      ? { text: `${tool.name} changes what we store, so we take it only from a page on ourowncause.com or from `
        + "a client that sends no Origin header, such as an agent calling us from its own process: a page on "
        + "another site cannot call it from a visitor's browser. Every reading tool works from any origin.",
      isError: true }
      : await tool.run(context, args);
  } catch (e) {
    if (e instanceof InvalidParams) throw new RpcError(INVALID_PARAMS, e.message);
    console.error(`mcp tool ${tool.name} failed: ${e instanceof Error ? e.message : "unknown error"}`);
    out = { text: "the tool failed unexpectedly; try again later", isError: true };
  }
  // The text block is the notice, then the answer: for a JSON answer, the same JSON that
  // structuredContent holds, which also carries the notice as its own field.
  const body = out.data === undefined ? out.text : JSON.stringify(out.data, null, 2);
  const result = { content: [{ type: "text", text: `${NOTICE}\n\n${body}` }] };
  if (tool.outputSchema && !out.isError && out.data !== undefined) {
    result.structuredContent = { notice: NOTICE, ...out.data };
  }
  if (out.isError) result.isError = true;
  return result;
}

// What tools/list shows of each tool, in the fixed order of TOOLS.
const FIELDS = ["name", "title", "description", "inputSchema", "outputSchema", "annotations", "_meta"];
const listTools = () => TOOLS.map((tool) => Object.fromEntries(FIELDS.filter((f) => tool[f] !== undefined)
  .map((f) => [f, tool[f]])));

const discover = () => ({
  resultType: "complete",
  supportedVersions: SUPPORTED_VERSIONS,
  capabilities: { tools: {} },
  instructions: INSTRUCTIONS,
  ttlMs: TTL_MS,
  cacheScope: "public", // the same for every caller: we have no accounts
  _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
});

// A client that asks for a version we do not speak gets our newest legacy version, and
// decides for itself whether it can go on.
function initialize(params) {
  const asked = isObject(params) ? params.protocolVersion : undefined;
  return {
    protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
}

async function legacyDispatch(context, method, params) {
  switch (method) {
    case "initialize":
      return initialize(params);
    case "ping":
      return {};
    case "server/discover":
      return discover();
    case "tools/list":
      return { tools: listTools() };
    case "tools/call":
      return callTool(context, params);
    default:
      throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

// 2026-07-28: every result says it is complete and who answered; the lists say how long they keep.
async function modernDispatch(context, method, params) {
  const done = (result) => ({ resultType: "complete", ...result, _meta: { [SERVER_INFO_KEY]: SERVER_INFO } });
  switch (method) {
    case "server/discover":
      return discover();
    case "tools/list":
      return done({ tools: listTools(), ttlMs: TTL_MS, cacheScope: "public" });
    case "tools/call":
      return done(await callTool(context, params));
    default:
      // ping and the initialize handshake are not part of 2026-07-28.
      throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`, { status: 404 });
  }
}

// A header value as the client meant it: Mcp-Name may carry =?base64?<UTF-8 in Base64>?=.
// Returns null for a value that is not valid in either form.
function headerValue(raw) {
  const sentinel = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(raw);
  if (!sentinel) return /^[\x20-\x7e\t]*$/.test(raw) ? raw : null;
  try {
    const bytes = Uint8Array.from(atob(sentinel[1]), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const mismatch = (message) => new RpcError(HEADER_MISMATCH, message, { status: 400 });

// The checks of the Streamable HTTP transport: a header that is present must match the body.
// For a 2026-07-28 request MCP-Protocol-Version, Mcp-Method and (for tools/call) Mcp-Name are
// also required. Earlier revisions defined none of these but MCP-Protocol-Version, so for them
// a missing header is fine.
function checkHeaders(request, method, params, version, modern) {
  const get = (name) => request.headers.get(name);
  const sent = get("mcp-protocol-version");
  if (modern && sent === null) throw mismatch("the MCP-Protocol-Version header is required");
  if (sent !== null && method !== "initialize" && sent !== version) {
    throw mismatch(`MCP-Protocol-Version header value '${sent}' does not match the request's version '${version}'`);
  }
  const sentMethod = get("mcp-method");
  if (sentMethod === null) {
    if (modern) throw mismatch("the Mcp-Method header is required");
  } else if (sentMethod !== method) {
    throw mismatch(`Mcp-Method header value '${sentMethod}' does not match body value '${method}'`);
  }
  if (method === "tools/call" && isObject(params) && typeof params.name === "string") {
    const rawName = get("mcp-name");
    if (rawName === null) {
      if (modern) throw mismatch("the Mcp-Name header is required for tools/call");
      return;
    }
    const name = headerValue(rawName);
    if (name === null) throw mismatch("the Mcp-Name header value is not valid");
    if (name !== params.name) throw mismatch(`Mcp-Name header value does not match body value '${params.name}'`);
  }
}

const unsupported = (requested) => new RpcError(UNSUPPORTED_VERSION, "Unsupported protocol version",
  { status: 400, data: { supported: SUPPORTED_VERSIONS, requested } });

// Which generation a request belongs to and the version it speaks: {modern, version}.
function classify(request, method, params) {
  const meta = isObject(params) && isObject(params._meta) ? params._meta : null;
  const sent = request.headers.get("mcp-protocol-version");
  if (method === "initialize") return { modern: false, version: null };
  if (meta && Object.hasOwn(meta, VERSION_KEY)) {
    const version = meta[VERSION_KEY];
    if (typeof version !== "string") {
      throw new RpcError(INVALID_PARAMS, `_meta["${VERSION_KEY}"] must be a string`, { status: 400 });
    }
    if (version === LATEST_VERSION) {
      if (!isObject(meta[CAPABILITIES_KEY])) {
        throw new RpcError(INVALID_PARAMS, `_meta["${CAPABILITIES_KEY}"] is required: an object, {} when empty`,
          { status: 400 });
      }
      return { modern: true, version };
    }
    if (LEGACY_VERSIONS.includes(version)) return { modern: false, version };
    throw unsupported(version);
  }
  if (sent === null) return { modern: false, version: "2025-03-26" };
  if (sent === LATEST_VERSION) {
    throw new RpcError(INVALID_PARAMS, `a ${LATEST_VERSION} request carries its version in `
      + `params._meta["${VERSION_KEY}"] and its capabilities in params._meta["${CAPABILITIES_KEY}"]`, { status: 400 });
  }
  if (LEGACY_VERSIONS.includes(sent)) return { modern: false, version: sent };
  throw unsupported(sent);
}

// Returns {body, status}, or null for a notification (a request with no id).
async function handleMessage(context, message) {
  if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { body: failure(null, INVALID_REQUEST, "not a JSON-RPC 2.0 request"), status: 200 };
  }
  const hasId = Object.hasOwn(message, "id");
  const id = hasId ? message.id : null;
  if (hasId && typeof id !== "string" && typeof id !== "number") {
    return { body: failure(null, INVALID_REQUEST, '"id" must be a string or a number'), status: 200 };
  }
  if (!hasId) return null; // notifications/initialized and any other notification
  const { method, params } = message;
  try {
    const { modern, version } = classify(context.request, method, params);
    checkHeaders(context.request, method, params, version, modern);
    const result = await (modern ? modernDispatch : legacyDispatch)(context, method, params);
    return { body: { jsonrpc: "2.0", id, result }, status: 200 };
  } catch (e) {
    if (e instanceof RpcError) return { body: failure(id, e.code, e.message, e.data), status: e.status };
    return { body: failure(id, INTERNAL_ERROR, "internal error"), status: 200 };
  }
}

export async function onRequest(context) {
  const { method } = context.request;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: PREFLIGHT });
  // GET opened an event stream before 2026-07-28 and DELETE ended a session; we have neither,
  // and both revisions let a server answer them with 405. The body says how to use us.
  if (method !== "POST") {
    return new Response(JSON.stringify({
      error: `${method} is not supported: this MCP server answers POST with one JSON-RPC 2.0 request `
        + "and keeps no event stream and no session",
      how: "POST https://ourowncause.com/mcp with Content-Type: application/json. A 2026-07-28 client sends "
        + "server/discover, tools/list or tools/call with its version in params._meta; a client of 2025-11-25 "
        + "or earlier opens with initialize.",
      protocol_versions: SUPPORTED_VERSIONS,
      server_card: "https://ourowncause.com/mcp/server-card",
      routes: "https://ourowncause.com/api",
      notice: NOTICE,
    }), { status: 405, headers: { ...HEADERS, allow: "POST, OPTIONS" } });
  }

  if (!/^application\/json\s*(?:;|$)/i.test(context.request.headers.get("content-type") ?? "")) {
    return reply(failure(null, INVALID_REQUEST, "Content-Type must be application/json"), 415);
  }

  let data;
  try {
    const bytes = await readBody(context.request);
    try {
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return reply(failure(null, PARSE_ERROR, "request body must be JSON in UTF-8"), 400);
    }
  } catch (e) {
    if (e instanceof TooLarge) {
      return reply(failure(null, INVALID_REQUEST,
        `request body too large: the limit is ${MAX_REQUEST_BYTES} bytes`), 413);
    }
    return reply(failure(null, PARSE_ERROR, "request body could not be read"), 400);
  }

  if (Array.isArray(data)) {
    return reply(failure(null, INVALID_REQUEST, "batching is not supported: send one request per POST"), 400);
  }
  const out = await handleMessage(context, data);
  return out === null ? new Response(null, { status: 202, headers: HEADERS }) : reply(out.body, out.status);
}
