// Entry for `node --test functions/test`: Node 22 reads the directory argument as a module
// path and loads this file, which runs every *.test.mjs beside it.
import { readdirSync } from "node:fs";

const here = new URL("./", import.meta.url);
for (const name of readdirSync(here).filter((n) => n.endsWith(".test.mjs")).sort()) {
  await import(new URL(name, here));
}
