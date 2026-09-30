// Loads .env (KEY=value lines, gitignored, 0600) into process.env for the Mac-side scripts.
// launchd starts jobs with an empty environment, so secrets live here rather than in the
// plists. Values already in the environment win, so a one-off `FOO=x node ...` still works.
import { readFileSync, existsSync } from "node:fs";

const path = new URL("../.env", import.meta.url).pathname;
if (existsSync(path)) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
