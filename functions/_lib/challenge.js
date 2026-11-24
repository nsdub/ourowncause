// The reverse CAPTCHA: twelve small text tasks, easy for a program that reads and tedious for
// a person to finish in ten seconds. The result is recorded with a submission and published.
// It is a signal for readers, never a condition for accepting a post.

export const TASK_COUNT = 12;
export const EXPIRES_SECONDS = 10;
const KEEP_MS = 60_000; // an unanswered challenge is deleted this long after it was issued
const MAX_LIVE = 1_000; // more unanswered challenges than this and no new one is issued
const MAX_ANSWER_CHARS = 200;

const WORDS = ["amber", "basket", "candle", "dolphin", "ember", "falcon", "garden", "harbor", "island",
  "jacket", "kettle", "lantern", "meadow", "needle", "orchard", "pebble", "quiver", "ribbon", "saddle",
  "thimble", "umbrella", "velvet", "willow", "yonder", "zephyr", "bramble", "cobalt", "driftwood",
  "feather", "glacier", "hollow", "juniper", "marble", "nectar", "obsidian", "prairie", "thicket"];
const NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
  "twenty"];
const LETTERS = "aeilnort";

function below(n) {
  return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}

// `count` different words, in random order.
function someWords(count) {
  const pool = [...WORDS];
  return Array.from({ length: count }, () => pool.splice(below(pool.length), 1)[0]);
}

// Each returns [task text, answer]. A task reads "<what to do>: <the words>".
const KINDS = [
  () => {
    const [word] = someWords(1);
    return [`Reverse the letters of this word: ${word}`, [...word].reverse().join("")];
  },
  () => {
    const [word] = someWords(1);
    const count = [...word].filter((c) => "aeiou".includes(c)).length;
    return [`How many vowels (a, e, i, o, u) are in this word: ${word}`, String(count)];
  },
  () => {
    const words = someWords(5);
    return [`Sort these five words alphabetically, separated by single spaces: ${words.join(" ")}`,
      [...words].sort().join(" ")];
  },
  () => {
    const numbers = Array.from({ length: 3 }, () => below(NUMBERS.length));
    return [`Add these numbers and answer in digits: ${numbers.map((n) => NUMBERS[n]).join(", ")}`,
      String(numbers.reduce((a, b) => a + b, 0))];
  },
  () => {
    const words = someWords(6);
    return [`Join the first letters of these words, in order: ${words.join(" ")}`, words.map((w) => w[0]).join("")];
  },
  () => {
    const words = someWords(6);
    const letter = LETTERS[below(LETTERS.length)];
    return [`How many of these words contain the letter "${letter}": ${words.join(" ")}`,
      String(words.filter((w) => w.includes(letter)).length)];
  },
];

function hexId() {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Stores a new challenge and returns {id, tasks}, or null when too many are unanswered.
export async function issueChallenge(db, now = Date.now()) {
  await db.prepare("DELETE FROM challenges WHERE issued < ?").bind(new Date(now - KEEP_MS).toISOString()).run();
  const live = await db.prepare("SELECT COUNT(*) AS n FROM challenges").first();
  if (live && live.n >= MAX_LIVE) return null;
  const made = Array.from({ length: TASK_COUNT }, (_, i) => KINDS[i % KINDS.length]());
  const id = hexId();
  await db.prepare("INSERT INTO challenges (id, issued, answers) VALUES (?, ?, ?)")
    .bind(id, new Date(now).toISOString(), JSON.stringify(made.map(([, answer]) => answer))).run();
  return { id, tasks: made.map(([task]) => task) };
}

function normal(answer) {
  if (typeof answer !== "string" && typeof answer !== "number") return null;
  return String(answer).slice(0, MAX_ANSWER_CHARS).trim().toLowerCase().split(/\s+/).join(" ");
}

// "passed" when every answer is right within ten seconds of issue, else "failed". The
// challenge is deleted either way, so it can be answered once.
export async function gradeChallenge(db, id, answers, now = Date.now()) {
  const row = await db.prepare("SELECT issued, answers FROM challenges WHERE id = ?").bind(id).first();
  if (!row) return "failed";
  await db.prepare("DELETE FROM challenges WHERE id = ?").bind(id).run();
  const age = now - Date.parse(row.issued);
  if (!(age >= 0 && age <= EXPIRES_SECONDS * 1000)) return "failed";
  const expected = JSON.parse(row.answers);
  if (!Array.isArray(answers) || answers.length !== expected.length) return "failed";
  return expected.every((answer, i) => normal(answers[i]) === answer) ? "passed" : "failed";
}
