// Post-push read-back check: does the table now on the deploy target carry EVERY applied action?
//   bench:KEY        entry present and enabled === false
//   unbench:KEY      entry present and enabled !== false
//   sabr-bench:KEY   entry.sabr present and sabr.enabled === false
//   sabr-unbench:KEY entry.sabr present and sabr.enabled !== false
//   bump:KEY         every field of the verified bump equals the entry's value
// Returns the actions the deployed file does NOT carry (empty = verified). Pure; the workflow
// feeds it the read-back JSON and /tmp/bumps.json.
//
//   node tools/clients/verify-deploy.mjs <deployed.json> <bumps.json> "<applied actions>"

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function missingActions(deployed, bumps, applied) {
  const bad = [];
  for (const a of String(applied || "").split(/\s+/).filter(Boolean)) {
    const [op, key] = a.split(":");
    const e = (deployed.clients || []).find((c) => c && c.key === key);
    if (!e) { bad.push(a); continue; }
    if (op === "bump") {
      const fields = (bumps.find((b) => b.key === key) || {}).fields || {};
      if (!Object.keys(fields).length || !Object.entries(fields).every(([f, v]) => e[f] === v)) bad.push(a);
    } else if (op === "sabr-bench" || op === "sabr-unbench") {
      if (!e.sabr || (op === "sabr-bench") !== (e.sabr.enabled === false)) bad.push(a);
    } else if (op === "bench" || op === "unbench") {
      if ((op === "bench") !== (e.enabled === false)) bad.push(a);
    } else bad.push(a);
  }
  return bad;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [deployedPath, bumpsPath, applied] = process.argv.slice(2);
  const deployed = JSON.parse(readFileSync(deployedPath, "utf8"));
  let bumps = []; try { bumps = JSON.parse(readFileSync(bumpsPath, "utf8")); } catch {}
  process.stdout.write(missingActions(deployed, bumps, applied).join(","));
}
