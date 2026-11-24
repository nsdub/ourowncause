// Counting by address without keeping the address: a salted hash that changes each day, in
// the ratelimit table, whose rows from earlier days are deleted.

const DAY_SECONDS = 86_400;
// Not a secret: with the day, it only keeps one day's hashes from matching another day's.
const SALT = "ourowncause.com/api/submit";
const MAX_ADDRESS_CHARS = 100;

export const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256(text) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

// What an address is counted as. One IPv6 subscriber holds a whole /64 and can use a new
// address from it for every request, so IPv6 is counted by its first 64 bits.
export function addressKey(ip) {
  if (typeof ip !== "string" || ip === "") return "unknown";
  const text = ip.slice(0, MAX_ADDRESS_CHARS).toLowerCase();
  if (!text.includes(":")) return text;
  const [head, tail] = text.split("::");
  const before = head ? head.split(":") : [];
  const after = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? [] : Array(Math.max(0, 8 - before.length - after.length)).fill("0");
  const groups = [...before, ...zeros, ...after].slice(0, 4);
  return `${groups.map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export function ipDayHash(request, day) {
  return sha256(`${SALT}|${day}|${addressKey(request.headers.get("cf-connecting-ip"))}`);
}

// Adds one to today's count for `key` and returns the new count.
export async function countOne(db, day, key) {
  const row = await db.prepare(
    "INSERT INTO ratelimit (day, ip_hash, n) VALUES (?, ?, 1) "
    + "ON CONFLICT (day, ip_hash) DO UPDATE SET n = n + 1 RETURNING n",
  ).bind(day, key).first();
  return row.n;
}

export function forgetEarlierDays(db, day) {
  return db.prepare("DELETE FROM ratelimit WHERE day < ?").bind(day).run().catch(() => {});
}

// Seconds until the count starts again at 00:00 UTC.
export function secondsToMidnight(now = Date.now()) {
  return DAY_SECONDS - Math.floor((now / 1000) % DAY_SECONDS);
}
