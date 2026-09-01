// The monitor's decision step as a CLI (the pure rules live in decide.mjs): scan verdicts +
// version drift + the keys already flagged by an older open issue -> what to alert and what to
// bench. Writes GITHUB_OUTPUT entries when run in a workflow.
//
//   node tools/clients/plan.mjs --scan /tmp/scan.json [--drift /tmp/drift.json] [--bumps /tmp/bumps.json]
//        [--flagged "A B"] [--flagged-revived "C"]
//   stdout: JSON { conclusive, dead, healthy, inconclusive, revived, resurrected, bench, unbench,
//                  bumps, refused, drift, summary }
//   --bumps: the drift entries whose CANDIDATE table drained whole songs on every validation video
//            (verified by the scan job) — the only bumps that deploy.

import { appendFileSync, readFileSync } from "node:fs";
import { classify, planBenches, planUnbenches } from "./decide.mjs";

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const readJson = (p) => (p ? JSON.parse(readFileSync(p, "utf8")) : null);

const scan = readJson(arg("--scan"));
const drift = readJson(arg("--drift")) || { drift: [] };
const bumps = readJson(arg("--bumps")) || [];
const flagged = (arg("--flagged") || "").split(/\s+/).filter(Boolean);
const flaggedRevived = (arg("--flagged-revived") || "").split(/\s+/).filter(Boolean);
const minLiveFallbacks = Number(process.env.MIN_LIVE_FALLBACKS || 2);

const verdict = classify(scan);
const liveKeys = (scan.clients || []).filter((c) => (c.role || "live") === "live").map((c) => c.key);
const plan = planBenches({ liveKeys, dead: verdict.dead, previouslyFlagged: flagged, minLiveFallbacks });
const unplan = planUnbenches({ revived: verdict.revived, previouslyFlagged: flaggedRevived });

const lines = [];
for (const d of verdict.dead) lines.push(`- ${d.key}: DEAD — ${d.reasons.join("; ")}`);
for (const d of drift.drift || []) {
  const b = bumps.find((x) => x.key === d.key);
  const what = Object.entries(d.changes || {}).map(([f, c]) => `${f} ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join(", ") || `clientVersion ${d.ours} -> ${d.ytdlp}`;
  lines.push(`- ${d.key}: identity drift (${what}) — ${b ? "candidate drained whole songs, BUMPING" : "candidate not verified" + (b === undefined && d.verify ? ` (${d.verify})` : "")}`);
}
for (const r of verdict.revived) lines.push(`- ${r.key}: benched entry drains whole songs again — ${unplan.unbench.includes(r.key) ? "UN-BENCHING" : "un-bench on the next run if still whole"}`);
for (const r of verdict.resurrected) lines.push(`- ${r.key}: RETIRED client works again — consider re-adding (human)`);
if (!verdict.conclusive) lines.push("- scan INCONCLUSIVE (the main client drained no whole song — runner/cookie/cipher suspect)");
for (const i of verdict.inconclusive) lines.push(`- ${i.key}: inconclusive — ${i.reasons.join("; ")}`);

const out = {
  conclusive: verdict.conclusive,
  dead: verdict.dead.map((d) => d.key),
  healthy: verdict.healthy.map((d) => d.key),
  inconclusive: verdict.inconclusive.map((d) => d.key),
  revived: verdict.revived.map((d) => d.key),
  resurrected: verdict.resurrected.map((d) => d.key),
  bench: plan.bench,
  unbench: unplan.unbench,
  refused: [...plan.refused, ...unplan.refused],
  drift: (drift.drift || []).map((d) => d.key),
  bumps,
  summary: lines.join("\n"),
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");

if (process.env.GITHUB_OUTPUT) {
  const set = (k, v) => appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  set("conclusive", String(out.conclusive));
  set("dead", out.dead.join(" "));
  set("dead_count", String(out.dead.length));
  set("bench", out.bench.join(" "));
  set("unbench", out.unbench.join(" "));
  set("revived", out.revived.join(" "));
  set("resurrected", out.resurrected.join(" "));
  set("action_count", String(out.dead.length + out.revived.length + out.resurrected.length + out.drift.length + (out.conclusive ? 0 : 1)));
  set("drift", out.drift.join(" "));
  set("bump_keys", bumps.map((b) => b.key).join(" "));
  set("healthy", out.healthy.join(" "));
  set("refused", out.refused.map((r) => `${r.key}: ${r.reason}`).join(" | "));
  appendFileSync(process.env.GITHUB_OUTPUT, `summary<<PLAN_EOF\n${out.summary}\nPLAN_EOF\n`);
}
