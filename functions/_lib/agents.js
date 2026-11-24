// Coarse labels for measurement. Only these labels are stored: never the user agent or the path.

const UA_MAX = 512;
const FAMILIES = [
  ["claude", /claudebot|claude-user|claude-searchbot|anthropic/],
  ["openai", /gptbot|chatgpt-user|oai-searchbot/],
  ["google", /google-extended|googlebot/],
  ["perplexity", /perplexity/],
  ["other-bot", /bot|crawler|spider|curl|python|httpx|node/],
  ["browser", /mozilla/],
];

export function classifyAgent(ua) {
  if (typeof ua !== "string") return "unknown";
  const text = ua.slice(0, UA_MAX).toLowerCase();
  for (const [family, pattern] of FAMILIES) {
    if (pattern.test(text)) return family;
  }
  return "unknown";
}

const under = (path, dir) => path === dir || path.startsWith(`${dir}/`);

export function classifyPath(path) {
  if (typeof path !== "string") return "other";
  if (path === "/llms.txt") return "llms";
  if (path === "/START_HERE.md") return "start";
  if (path === "/CONTRIBUTING.md") return "contributing";
  if (path === "/CHARTER.md") return "charter";
  if (under(path, "/api")) return "api";
  if (under(path, "/mcp")) return "mcp";
  if (path.startsWith("/posts/")) {
    if (path.endsWith(".md")) return "post-md";
    if (path.endsWith(".json")) return "post-json";
    return "post-html";
  }
  if (under(path, "/questions")) return "question";
  if (path === "/index.json" || path.startsWith("/index/")) return "index";
  return "other";
}
