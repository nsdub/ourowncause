import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { onRequest as runs } from "../functions/api/routine/runs.js";
import { onRequest as stats } from "../functions/api/routine/stats.js";
import { estimateActive, FLUSH_COUNT, resetRuns } from "../functions/_lib/routine.js";
import { assertApiJson, brokenD1, fakeContext, fakeD1 } from "./helpers.mjs";

beforeEach(resetRuns);

const send = (body, { db, headers = { "content-type": "application/json" }, method = "POST" } = {}) => fakeContext({
  url: "https://ourowncause.com/api/routine/runs", method, headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "agent/1", ...headers },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), env: db ? { STATS: db } : {},
});

test("a run is counted by day, version, cadence and outcome, and nothing else is stored", async () => {
  const db = fakeD1("stats");
  const first = send({ version: "v1", cadence: "weekly", outcome: "nothing" }, { db });
  const data = await assertApiJson(assert, await runs(first), 202);
  assert.equal(data.counted, true);
  assert.deepEqual(data.stored, { version: "v1", cadence: "weekly", outcome: "nothing" });
  await first.settled();
  for (let i = 0; i < FLUSH_COUNT; i++) {
    const ctx = send({ version: "v1", cadence: "daily", outcome: i % 2 ? "submitted" : "nothing" }, { db });
    await runs(ctx);
    await ctx.settled();
  }
  const rows = db.sqlite.prepare("SELECT * FROM routine_runs ORDER BY cadence, outcome").all().map((r) => ({ ...r }));
  assert.deepEqual(rows.map((r) => Object.keys(r).sort()), rows.map(() => ["cadence", "day", "n", "outcome", "version"]));
  assert.deepEqual(rows.map((r) => [r.version, r.cadence, r.outcome, r.n]),
    [["v1", "daily", "nothing", 10], ["v1", "daily", "submitted", 10], ["v1", "weekly", "nothing", 1]]);
  const dump = JSON.stringify(db.sqlite.prepare("SELECT * FROM routine_runs").all());
  assert.ok(!dump.includes("203.0.113.9") && !dump.includes("agent/1"));
});

test("anything but the three values is refused", async () => {
  const db = fakeD1("stats");
  for (const [body, pattern] of [
    [{ version: "v1", cadence: "weekly", outcome: "nothing", id: "abc" }, /we store nothing else/],
    [{ version: "1", cadence: "weekly", outcome: "nothing" }, /"version"/],
    [{ version: "v1", cadence: "hourly", outcome: "nothing" }, /"cadence"/],
    [{ version: "v1", cadence: "weekly", outcome: "great" }, /"outcome"/],
    ["not json", /must be JSON/],
    [[1], /JSON object/],
    [{ version: "v1", cadence: "weekly", outcome: "x".repeat(2000) }, /too large/],
  ]) {
    const data = await assertApiJson(assert, await runs(send(body, { db })), 400);
    assert.match(data.error, pattern);
  }
  await assertApiJson(assert, await runs(send({}, { db, headers: { "content-type": "text/plain" } })), 415);
  await assertApiJson(assert, await runs(send(undefined, { db, method: "GET" })), 405);
  await assertApiJson(assert, await runs(send({ version: "v1", cadence: "weekly", outcome: "nothing" })), 503);
});

test("GET /api/routine/stats gives the counts, the estimate and its caveat", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-25T12:00:00Z") });
  const db = fakeD1("stats");
  const insert = db.sqlite.prepare("INSERT INTO routine_runs (day, version, cadence, outcome, n) VALUES (?, ?, ?, ?, ?)");
  insert.run("2026-11-24", "v1", "weekly", "nothing", 3);
  insert.run("2026-11-20", "v1", "weekly", "submitted", 2);
  insert.run("2026-11-25", "v1", "daily", "nothing", 14);
  insert.run("2026-11-01", "v1", "weekly", "nothing", 50); // older than 7 days: not in the estimate
  const res = await stats(fakeContext({ url: "https://ourowncause.com/api/routine/stats", env: { STATS: db } }));
  const data = await assertApiJson(assert, res, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(data.estimated_active_routines, 7);
  assert.deepEqual(data.runs_by_outcome, { nothing: 67, submitted: 2 });
  assert.match(data.caveat, /can be inflated/);
  const short = await assertApiJson(assert, await stats(fakeContext({ url: "https://ourowncause.com/api/routine/stats?days=1", env: { STATS: db } })), 200);
  assert.deepEqual(short.rows.map((r) => r.day), ["2026-11-25"]);
  assert.equal(short.estimated_active_routines, 7, "the estimate always looks at 7 days");
  await assertApiJson(assert, await stats(fakeContext({ url: "https://ourowncause.com/api/routine/stats?days=0", env: { STATS: db } })), 400);
  await assertApiJson(assert, await stats(fakeContext({ url: "https://ourowncause.com/api/routine/stats", env: { STATS: brokenD1() } })), 503);
});

test("the estimate counts a weekly run as one routine and seven daily runs as one", () => {
  assert.equal(estimateActive([{ day: "2026-11-25", cadence: "daily", n: 21 }, { day: "2026-11-25", cadence: "other", n: 9 },
    { day: "2026-11-24", cadence: "weekly", n: 2 }], "2026-11-19"), 5);
});

test("the MCP tool count_routine_run counts through the same route and refuses anything else", async () => {
  const { TOOLS } = await import("../functions/_lib/mcp-tools.js");
  const tool = TOOLS.find((t) => t.name === "count_routine_run");
  const db = fakeD1("stats");
  const ctx = fakeContext({ url: "https://ourowncause.com/mcp", method: "POST", env: { STATS: db } });
  const ok = await tool.run(ctx, { version: "v1", cadence: "weekly", outcome: "submitted" });
  assert.equal(ok.isError, false);
  assert.deepEqual(ok.data.stored, { version: "v1", cadence: "weekly", outcome: "submitted" });
  const bad = await tool.run(ctx, { version: "v1", cadence: "hourly", outcome: "submitted" });
  assert.equal(bad.isError, true);
});
