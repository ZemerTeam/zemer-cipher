// Merge the scans of every VERIFIED egress slot into one: per client and video, per transport,
// a whole song from ANY slot is proof the client works; a failure counts only when EVERY slot that
// drained it failed definitively; otherwise the verdict is the most informative inconclusive one.
// So a false death needs every independent clean egress to be wrong at once, and one tunnel
// hiccup in one slot cannot mask a client that another slot drained whole.
//
//   node tools/clients/merge-slots.mjs <scan.json>... > merged.json
// Pure `mergeScans(scans)` is what the tests drive; drift/bumps come from the first slot.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFINITIVE = new Set(["partial", "sabr-only", "sabr-error", "no-sabr", "no-format", "not-ok", "http-error"]);

function mergeResults(lists) {
  const byVideo = new Map();
  for (const list of lists) for (const r of list) { if (!byVideo.has(r.video)) byVideo.set(r.video, []); byVideo.get(r.video).push(r); }
  const out = [];
  for (const [video, rs] of byVideo) {
    const whole = rs.find((r) => r.kind === "whole");
    if (whole) { out.push({ ...whole, slots: rs.length, agree: rs.filter((r) => r.kind === "whole").length }); continue; }
    if (rs.every((r) => DEFINITIVE.has(r.kind))) { out.push({ ...rs[0], slots: rs.length, agree: rs.length }); continue; }
    // Mixed definitive + inconclusive, or all inconclusive: report the inconclusive one (never a kill).
    const inc = rs.find((r) => !DEFINITIVE.has(r.kind)) || rs[0];
    out.push({ ...inc, slots: rs.length, agree: rs.filter((r) => r.kind === inc.kind).length, reason: `${inc.reason || inc.kind} (slots disagree: ${rs.map((r) => r.kind).join("/")})` });
  }
  return out;
}

export function mergeScans(scans) {
  if (!scans.length) throw new Error("no scans to merge");
  const base = scans[0];
  const keys = [...new Set(scans.flatMap((s) => s.clients.map((c) => c.key)))];
  const clients = keys.map((key) => {
    const versions = scans.map((s) => s.clients.find((c) => c.key === key)).filter(Boolean);
    const first = versions[0];
    return { ...first, results: mergeResults(versions.map((v) => v.results || [])), sabrResults: mergeResults(versions.map((v) => v.sabrResults || [])) };
  });
  const conclusive = clients.some((c) => c.results.some((r) => r.kind === "whole"));
  const sabrConclusive = clients.some((c) => c.sabrResults.some((r) => r.kind === "whole"));
  const mainHealthy = Boolean(clients.find((c) => c.main)?.results.some((r) => r.kind === "whole"));
  return { ...base, videos: [...new Set(scans.flatMap((s) => s.videos || []))], conclusive, sabrConclusive, mainHealthy, clients, mergedSlots: scans.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scans = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, "utf8")));
  process.stdout.write(JSON.stringify(mergeScans(scans), null, 2) + "\n");
}
