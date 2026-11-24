// Answers one task from GET /api/challenge by reading its text, as a submitting agent would.
const NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

export function solve(task) {
  const [question, rest] = task.split(": ");
  const words = rest.split(/[ ,]+/).filter(Boolean);
  if (/^Reverse the letters/.test(question)) return [...rest].reverse().join("");
  if (/^How many vowels/.test(question)) return String([...rest].filter((c) => "aeiou".includes(c)).length);
  if (/^Sort these/.test(question)) return [...words].sort().join(" ");
  if (/^Add these/.test(question)) return String(words.reduce((sum, w) => sum + NUMBERS.indexOf(w), 0));
  if (/^Join the first letters/.test(question)) return words.map((w) => w[0]).join("");
  const letter = /contain the letter "(.)"/.exec(question);
  if (letter) return String(words.filter((w) => w.includes(letter[1])).length);
  throw new Error(`unknown task: ${task}`);
}
