// Reliability report over the last N client-monitor runs: per run, which egress slots verified
// (runner, colo), whether the MERGED scan had every live client whole on both transports, what
// failed otherwise, and the wall-clock time. Uses the gh CLI (artifacts of completed runs).
//
//   node tools/clients/report-runs.mjs [N=10] [--repo ZemerTeam/zemer-cipher]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N = Number(process.argv[2] || 10);
const repo = process.argv.includes("--repo") ? process.argv[process.argv.indexOf("--repo") + 1] : "ZemerTeam/zemer-cipher";
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const runs = JSON.parse(gh("run", "list", "--repo", repo, "--workflow", "client-monitor.yml", "--limit", String(N), "--json", "databaseId,status,conclusion,event,createdAt,updatedAt,headSha"));
const rows = [];
let verifiedRuns = 0, allWholeRuns = 0, completed = 0;
for (const r of runs) {
  if (r.status !== "completed") { rows.push(`${r.databaseId} ${r.headSha.slice(0, 7)} ${r.event.padEnd(17)} ${r.status}`); continue; }
  completed++;
  const mins = ((new Date(r.updatedAt) - new Date(r.createdAt)) / 60000).toFixed(1);
  const dir = mkdtempSync(join(tmpdir(), "rr-"));
  let slots = [];
  try { gh("run", "download", String(r.databaseId), "--repo", repo, "-p", "client-scan-slot-*", "-D", dir); } catch {}
  for (const d of readdirSync(dir).sort()) {
    const e = join(dir, d, "egress.txt");
    if (existsSync(join(dir, d, "scan.json"))) slots.push(existsSync(e) ? readFileSync(e, "utf8").trim().replace(/slot=(\d+) /, "s$1 ").replace(/ egress=warp| ipv6=1| ip=[^ ]+/g, "") : d);
  }
  let verdict = "no verified slot", fails = [];
  const merged = join(dir, "merged");
  try { gh("run", "download", String(r.databaseId), "--repo", repo, "-n", "client-scan", "-D", merged); } catch {}
  if (existsSync(join(merged, "scan.json"))) {
    const s = JSON.parse(readFileSync(join(merged, "scan.json"), "utf8"));
    for (const c of s.clients.filter((c) => c.role === "live")) {
      if (!c.results.every((x) => x.kind === "whole")) fails.push(`${c.key}:direct:${c.results.map((x) => x.kind)}`);
      if (c.sabr === "live" && !c.sabrResults.every((x) => x.kind === "whole")) fails.push(`${c.key}:sabr:${c.sabrResults.map((x) => x.kind)}`);
    }
    verdict = fails.length ? `NOT ALL WHOLE (${fails.length})` : "ALL WHOLE";
    verifiedRuns++; if (!fails.length) allWholeRuns++;
  }
  rmSync(dir, { recursive: true, force: true });
  rows.push(`${r.databaseId} ${r.headSha.slice(0, 7)} ${r.event.padEnd(17)} ${String(r.conclusion).padEnd(9)} ${mins.padStart(5)}m  slots[${slots.length}]: ${slots.join(" | ") || "-"}  => ${verdict}${fails.length ? "  " + fails.join(" ") : ""}`);
}
console.log(rows.join("\n"));
console.log(`\ncompleted ${completed}, verified-egress runs ${verifiedRuns}, all-whole runs ${allWholeRuns}`);
