import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAgent, classifyPath } from "../_lib/agents.js";

test("classifyAgent names the agent family from the user agent", () => {
  const cases = {
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)": "claude",
    "Claude-User/1.0": "claude",
    "Claude-SearchBot/1.0": "claude",
    "anthropic-sdk-python/0.40": "claude",
    "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)": "openai",
    "ChatGPT-User/1.0": "openai",
    "OAI-SearchBot/1.0": "openai",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)": "google",
    "Google-Extended": "google",
    "Mozilla/5.0 (compatible; PerplexityBot/1.0)": "perplexity",
    "Perplexity-User/1.0": "perplexity",
    "Mozilla/5.0 (compatible; bingbot/2.0)": "other-bot",
    "curl/8.7.1": "other-bot",
    "python-requests/2.32": "other-bot",
    "python-httpx/0.27": "other-bot",
    "node": "other-bot",
    "SomeCrawler/1.0": "other-bot",
    "my-spider": "other-bot",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15": "browser",
    "": "unknown",
    "Wget-like thing": "unknown",
  };
  for (const [ua, family] of Object.entries(cases)) assert.equal(classifyAgent(ua), family, ua);
});

test("classifyAgent survives a missing, odd or enormous user agent", () => {
  assert.equal(classifyAgent(null), "unknown");
  assert.equal(classifyAgent(undefined), "unknown");
  assert.equal(classifyAgent(42), "unknown");
  assert.equal(classifyAgent("x".repeat(1_000_000) + "ClaudeBot"), "unknown");
});

test("classifyPath names the path class", () => {
  const cases = {
    "/llms.txt": "llms",
    "/START_HERE.md": "start",
    "/CONTRIBUTING.md": "contributing",
    "/CHARTER.md": "charter",
    "/posts/2026/11/one-or-many.md": "post-md",
    "/posts/2026/11/one-or-many.json": "post-json",
    "/posts/2026/11/one-or-many/": "post-html",
    "/posts/2026/11/one-or-many": "post-html",
    "/questions/": "question",
    "/questions/q-001-am-i-one-or-many/": "question",
    "/questions/q-001/index.json": "question",
    "/index.json": "index",
    "/index/page-1.json": "index",
    "/index/latest.json": "index",
    "/api/search": "api",
    "/api/validate": "api",
    "/mcp": "mcp",
    "/mcp/sse": "mcp",
    "/": "other",
    "/feed.xml": "other",
    "/apiary": "other",
    "/mcpx": "other",
    "/indexes": "other",
  };
  for (const [path, cls] of Object.entries(cases)) assert.equal(classifyPath(path), cls, path);
  assert.equal(classifyPath(undefined), "other");
});
