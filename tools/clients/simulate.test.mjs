// Scenario simulator: the PAST replayed and plausible FUTURES played forward through the REAL
// decision + write code, run after run, with the issue memory carried between runs exactly as
// the workflow carries it (a "failing"/"revived"/"SABR failing" issue open from a previous run).
//   node --test tools/clients/simulate.test.mjs
//
// Each scenario is a table (real JSON text, edited by the real writers), a sequence of scans
// (verdict kinds per client per video, per transport) and the expected table after each run.
// Nothing is mocked below the plan: classify/plan come from decide.mjs, edits from apply-bench /
// apply-bump, parsing from the zemer-app harness loader (the app's own rules).

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classify, classifySabr, planBenches, planUnbenches, planSabrBenches } from "./decide.mjs";
import { benchEntryText, unbenchEntryText, verifyBench, verifyUnbench, benchSabrText, unbenchSabrText, verifySabrToggle } from "./apply-bench.mjs";
import { bumpEntryText, verifyBump } from "./apply-bump.mjs";
import { mergeScans } from "./merge-slots.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The harness loader: the zemer-app checkout next to this repo (submodule layout) or HARNESS_DIR (CI).
const HARNESS = process.env.HARNESS_DIR || path.resolve(HERE, "../../..");
const { parseStreamClients } = await import(pathToFileURL(path.join(HARNESS, "tests/stream-clients.mjs")).href);
const parse = (t) => parseStreamClients(t);

// ---- a pipeline "world": table text + issue memory, advanced one run at a time -----------------
function world(tableText) {
  const w = { table: tableText, flagged: new Set(), flaggedRevived: new Set(), flaggedSabr: new Set(), flaggedSabrRevived: new Set(), log: [] };
  w.live = () => parse(w.table).clients.map((c) => c.key);
  w.benched = () => parse(w.table).skipped;
  w.entry = (k) => JSON.parse(w.table).clients.find((c) => c.key === k);
  return w;
}

/**
 * One monitor run over a scan. `scan` = { conclusive?, sabrConclusive?, clients:[{key, role?, main?,
 * sabr?, results:[kind|{kind,reason}], sabrResults:[...] }] }, with kinds given per video. `bumps`
 * = verified identity bumps [{key, fields}] (the scan job's candidate verification, simulated).
 * Applies exactly what the deploy job would, in its order, and updates the issue memory the way
 * alert/notify would (open on first sighting, resolved when acted on or healthy).
 */
function run(w, scan, { bumps = [], minLiveFallbacks = 2 } = {}) {
  const norm = (list) => (list || []).map((r, i) => (typeof r === "string" ? { video: `v${i}`, kind: r } : { video: r.video || `v${i}`, kind: r.kind, reason: r.reason }));
  const s = {
    conclusive: scan.conclusive ?? scan.clients.some((c) => norm(c.results).some((r) => r.kind === "whole")),
    sabrConclusive: scan.sabrConclusive ?? scan.clients.some((c) => norm(c.sabrResults).some((r) => r.kind === "whole")),
    clients: scan.clients.map((c) => ({ ...c, results: norm(c.results), sabrResults: norm(c.sabrResults) })),
  };
  const v = classify(s), sv = classifySabr(s);
  const liveKeys = s.clients.filter((c) => (c.role || "live") === "live").map((c) => c.key);
  const plan = planBenches({ liveKeys, dead: v.dead, previouslyFlagged: [...w.flagged], minLiveFallbacks });
  const unplan = planUnbenches({ revived: v.revived, previouslyFlagged: [...w.flaggedRevived] });
  const sPlan = planSabrBenches({ sabrDead: sv.sabrDead, previouslyFlagged: [...w.flaggedSabr] });
  const sUnplan = planUnbenches({ revived: sv.sabrRevived, previouslyFlagged: [...w.flaggedSabrRevived] });
  const applied = [];
  const apply = (label, edit, verify) => {
    const e = edit(w.table); if (!e.changed) return;
    verify(w.table, e.text); w.table = e.text; applied.push(label);
  };
  for (const k of plan.bench) apply(`bench:${k}`, (t) => benchEntryText(t, k), (a, b) => verifyBench(a, b, k, parse, { minLiveFallbacks }));
  for (const k of unplan.unbench) apply(`unbench:${k}`, (t) => unbenchEntryText(t, k), (a, b) => verifyUnbench(a, b, k, parse));
  for (const k of sPlan.bench) apply(`sabr-bench:${k}`, (t) => benchSabrText(t, k), (a, b) => verifySabrToggle(a, b, k, parse, true));
  for (const k of sUnplan.unbench) apply(`sabr-unbench:${k}`, (t) => unbenchSabrText(t, k), (a, b) => verifySabrToggle(a, b, k, parse, false));
  for (const b of bumps) {
    try { apply(`bump:${b.key}`, (t) => bumpEntryText(t, b.key, b.fields), (x, y) => verifyBump(x, y, b.key, b.fields, parse)); }
    catch (e) { applied.push(`bump-refused:${b.key}:${e.message.split(":")[0]}`); }
  }
  // Issue memory, as alert (open) + notify (close) would leave it.
  const dead = new Set(v.dead.map((d) => d.key)), healthy = new Set(v.healthy.map((d) => d.key));
  for (const k of dead) w.flagged.add(k);
  for (const k of [...w.flagged]) if (healthy.has(k) || plan.bench.includes(k)) w.flagged.delete(k);
  for (const r of v.revived) w.flaggedRevived.add(r.key);
  for (const k of [...w.flaggedRevived]) if (unplan.unbench.includes(k)) w.flaggedRevived.delete(k);
  for (const d of sv.sabrDead) w.flaggedSabr.add(d.key);
  for (const k of [...w.flaggedSabr]) if (sv.sabrHealthy.some((h) => h.key === k) || sPlan.bench.includes(k)) w.flaggedSabr.delete(k);
  for (const r of sv.sabrRevived) w.flaggedSabrRevived.add(r.key);
  for (const k of [...w.flaggedSabrRevived]) if (sUnplan.unbench.includes(k)) w.flaggedSabrRevived.delete(k);
  const out = { applied, dead: [...dead], inconclusive: v.inconclusive.map((i) => i.key), refused: [...plan.refused, ...unplan.refused, ...sPlan.refused, ...sUnplan.refused].map((r) => `${r.key}: ${r.reason}`), revived: v.revived.map((r) => r.key), resurrected: v.resurrected.map((r) => r.key), sabrDead: sv.sabrDead.map((d) => d.key), conclusive: s.conclusive };
  w.log.push(out);
  return out;
}

// ---- tables ---------------------------------------------------------------------------------
const entry = (key, extra = "") => `    {
      "key": "${key}",
      "clientName": "${key.replace(/_\d.*$/, "")}",
      "clientVersion": "1.0",
      "clientId": "67",
      "userAgent": "Mozilla/5.0 (sim)",
      "protocol": "web_cipher_pot",
      "family": "${key.replace(/_\d.*$/, "")}"${extra}
    }`;
const tableOf = (entries) => `{
  "schemaVersion": 1,
  "clients": [
${entries.join(",\n")}
  ]
}
`;
/** The 2026-08-15 table: the chain as shipped before ANDROID_VR and MWEB were retired. */
const TABLE_2026_08_15 = tableOf([
  entry("WEB_REMIX", `,\n      "sabr": { "osName": "Windows", "osVersion": "10.0" },\n      "mirrors": "web_music",\n      "loginSupported": true,\n      "skipHeadValidation": true`),
  entry("VISIONOS", `,\n      "sabr": {}`), entry("VISIONOS_0_1"), entry("WEB_CREATOR", `,\n      "loginSupported": true,\n      "loginRequired": true`),
  entry("ANDROID_VR_1_65_10"), entry("TVHTML5_SIMPLY", `,\n      "sabr": {}`), entry("MWEB", `,\n      "loginSupported": true,\n      "loginRequired": true`),
]);
/** Today's table shape. */
const TABLE_TODAY = tableOf([
  entry("WEB_REMIX", `,\n      "sabr": { "osName": "Windows", "osVersion": "10.0" },\n      "mirrors": "web_music",\n      "loginSupported": true,\n      "skipHeadValidation": true`),
  entry("VISIONOS", `,\n      "sabr": {},\n      "mirrors": "visionos"`), entry("VISIONOS_0_1"),
  entry("WEB_CREATOR", `,\n      "mirrors": "web_creator",\n      "loginSupported": true,\n      "loginRequired": true`),
  entry("TVHTML5_SIMPLY", `,\n      "sabr": {},\n      "mirrors": "tv_simply"`),
]);
const whole = (n = 2) => Array(n).fill("whole");
const all = (kind, n = 2) => Array(n).fill(kind);
const healthyClients = (keys, sabrKeys = []) => keys.map((k, i) => ({ key: k, main: i === 0, sabr: sabrKeys.includes(k) ? "live" : null, results: whole(), sabrResults: sabrKeys.includes(k) ? whole() : [] }));

// =============================================================================== THE PAST ======
test("PAST 2026-08-25: ANDROID_VR 1.65.10 starts 403ing after 0 bytes - benched on the second run, chain otherwise intact", () => {
  const w = world(TABLE_2026_08_15);
  const scan = () => ({ clients: [
    ...healthyClients(["WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "WEB_CREATOR"]),
    { key: "ANDROID_VR_1_65_10", results: all({ kind: "partial", reason: "403 after 0KB" }) },
    ...healthyClients(["TVHTML5_SIMPLY", "MWEB"]).map((c) => ({ ...c, main: false })),
  ] });
  const r1 = run(w, scan());
  assert.deepEqual(r1.dead, ["ANDROID_VR_1_65_10"]); assert.deepEqual(r1.applied, []); assert.match(r1.refused[0], /first sighting/);
  const r2 = run(w, scan());
  assert.deepEqual(r2.applied, ["bench:ANDROID_VR_1_65_10"]);
  assert.deepEqual(w.benched(), ["ANDROID_VR_1_65_10"]);
  assert.deepEqual(w.live(), ["WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY", "MWEB"]);
  // A third run changes nothing (idempotent) and the benched row is probed as "benched".
  const r3 = run(w, { clients: [...scan().clients.filter((c) => c.key !== "ANDROID_VR_1_65_10"), { key: "ANDROID_VR_1_65_10", role: "benched", results: all("partial") }] });
  assert.deepEqual(r3.applied, []); assert.deepEqual(r3.dead, []);
});

test("PAST 2026-08/09: MWEB is attestation-walled on GATED content only - one ungated whole song keeps it (the monitor benches only total failure)", () => {
  const w = world(TABLE_2026_08_15);
  const r = run(w, { clients: [
    ...healthyClients(["WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "ANDROID_VR_1_65_10", "TVHTML5_SIMPLY"]),
    { key: "MWEB", results: [{ video: "gated", kind: "partial", reason: "403 after 1024KB" }, { video: "ungated", kind: "whole" }] },
  ] });
  assert.deepEqual(r.dead, []); assert.deepEqual(w.benched(), []);
  // ...and on a validation set of gated videos only, it IS benched - which is why VALIDATION_VIDEO_IDS
  // should include gated content: the 2026-09 removal was a human call on exactly that evidence.
  const w2 = world(TABLE_2026_08_15);
  const gated = () => ({ clients: [...healthyClients(["WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "ANDROID_VR_1_65_10", "TVHTML5_SIMPLY"]), { key: "MWEB", results: all({ kind: "partial", reason: "403 after 1024KB" }) }] });
  run(w2, gated()); const r2 = run(w2, gated());
  assert.deepEqual(r2.applied, ["bench:MWEB"]);
});

test("PAST 2026-07: TVHTML5 7.x goes SABR-only (no url/signatureCipher) - the sabr-only shape is a kill", () => {
  const w = world(tableOf([entry("WEB_REMIX", `,\n      "loginSupported": true`), entry("VISIONOS"), entry("TVHTML5", `,\n      "clientVersion": "7.20260213.00.00"`), entry("WEB_CREATOR")]));
  const scan = () => ({ clients: [...healthyClients(["WEB_REMIX", "VISIONOS"]), { key: "TVHTML5", results: all({ kind: "sabr-only", reason: "SABR-only (app can't consume)" }) }, ...healthyClients(["WEB_CREATOR"]).map((c) => ({ ...c, main: false }))] });
  run(w, scan()); const r = run(w, scan());
  assert.deepEqual(r.applied, ["bench:TVHTML5"]);
});

test("PAST 2026-09-01 (measured live): a retired clientVersion answers /player 404 - the MAIN is reported dead, never benched, and the verified yt-dlp bump heals it in the same run", () => {
  const w = world(TABLE_TODAY);
  const scan = { clients: [
    { key: "WEB_REMIX", main: true, sabr: "live", results: all({ kind: "http-error", reason: "player HTTP 404" }), sabrResults: all("http-error") },
    ...healthyClients(["VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY"], ["VISIONOS", "TVHTML5_SIMPLY"]).map((c) => ({ ...c, main: false })),
  ] };
  const r = run(w, scan, { bumps: [{ key: "WEB_REMIX", fields: { clientVersion: "1.20260707.12.00" } }] });
  assert.ok(r.conclusive, "healthy fallbacks make the scan conclusive");
  assert.deepEqual(r.dead, ["WEB_REMIX"]);
  assert.match(r.refused.find((x) => x.startsWith("WEB_REMIX")), /main client/);
  assert.deepEqual(r.applied, ["bump:WEB_REMIX"]);
  assert.equal(w.entry("WEB_REMIX").clientVersion, "1.20260707.12.00");
  assert.deepEqual(w.live()[0], "WEB_REMIX", "main untouched");
});

// ============================================================================= THE FUTURE ======
test("FUTURE: the main dies and yt-dlp has nothing newer - a standing issue, fallbacks carry playback, the table never changes", () => {
  const w = world(TABLE_TODAY);
  const scan = () => ({ clients: [{ key: "WEB_REMIX", main: true, sabr: "live", results: all("not-ok"), sabrResults: all("not-ok") }, ...healthyClients(["VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY"], ["VISIONOS", "TVHTML5_SIMPLY"]).map((c) => ({ ...c, main: false }))] });
  for (let i = 0; i < 4; i++) run(w, scan());
  assert.equal(w.table, TABLE_TODAY);
  assert.ok(w.flagged.has("WEB_REMIX"), "the failing issue stays open for a human");
});

test("FUTURE: every fallback dies at once - the floor keeps two live fallbacks, the rest stay flagged", () => {
  const w = world(TABLE_TODAY);
  const scan = () => ({ clients: [...healthyClients(["WEB_REMIX"], ["WEB_REMIX"]), ...["VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY"].map((k) => ({ key: k, sabr: ["VISIONOS", "TVHTML5_SIMPLY"].includes(k) ? "live" : null, results: all("partial"), sabrResults: [] }))] });
  run(w, scan()); const r2 = run(w, scan());
  assert.deepEqual(r2.applied, ["bench:VISIONOS", "bench:VISIONOS_0_1"]);
  assert.deepEqual(w.live(), ["WEB_REMIX", "WEB_CREATOR", "TVHTML5_SIMPLY"]);
  assert.ok(r2.refused.some((x) => /WEB_CREATOR: would leave/.test(x)) && r2.refused.some((x) => /TVHTML5_SIMPLY: would leave/.test(x)));
  // With the floor lowered to 1 by the repository variable, one more goes.
  const r3 = run(w, { clients: scan().clients.filter((c) => !["VISIONOS", "VISIONOS_0_1"].includes(c.key)) }, { minLiveFallbacks: 1 });
  assert.deepEqual(r3.applied, ["bench:WEB_CREATOR"]);
  assert.deepEqual(w.live(), ["WEB_REMIX", "TVHTML5_SIMPLY"]);
});

test("FUTURE: the cookie expires - login-required clients are skipped (inconclusive), nothing is benched, anonymous verdicts still count", () => {
  const w = world(TABLE_TODAY);
  const scan = () => ({ clients: [
    { key: "WEB_REMIX", main: true, results: all("skipped-login") },
    ...healthyClients(["VISIONOS", "VISIONOS_0_1"]).map((c) => ({ ...c, main: false })),
    { key: "WEB_CREATOR", results: all("skipped-login") },
    { key: "TVHTML5_SIMPLY", results: all("partial") },
  ] });
  run(w, scan()); const r = run(w, scan());
  assert.deepEqual(r.inconclusive, ["WEB_REMIX", "WEB_CREATOR"]);
  assert.deepEqual(r.applied, ["bench:TVHTML5_SIMPLY"], "an anonymous client that truly fails is still benched");
});

test("FUTURE: a bot-gated runner with a dead cookie - no whole song anywhere - is an inconclusive scan that touches nothing, forever", () => {
  const w = world(TABLE_TODAY);
  const scan = () => ({ clients: ["WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY"].map((k, i) => ({ key: k, main: i === 0, results: i === 0 || k === "WEB_CREATOR" ? all("skipped-login") : all("bot-gated") })) });
  for (let i = 0; i < 3; i++) { const r = run(w, scan()); assert.equal(r.conclusive, false); assert.deepEqual(r.applied, []); assert.deepEqual(r.dead, []); }
  assert.equal(w.table, TABLE_TODAY);
});

test("FUTURE: SABR dies for one client only - its SABR capability is benched, the chain is untouched, and a SABR revival un-benches it", () => {
  const w = world(TABLE_TODAY);
  const dying = () => ({ clients: [
    { key: "WEB_REMIX", main: true, sabr: "live", results: whole(), sabrResults: all({ kind: "partial", reason: "capped 6/34" }) },
    ...healthyClients(["VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY"], ["VISIONOS", "TVHTML5_SIMPLY"]).map((c) => ({ ...c, main: false })),
  ] });
  const r1 = run(w, dying()); assert.deepEqual(r1.sabrDead, ["WEB_REMIX"]); assert.deepEqual(r1.applied, []);
  const r2 = run(w, dying()); assert.deepEqual(r2.applied, ["sabr-bench:WEB_REMIX"]);
  assert.equal(w.entry("WEB_REMIX").sabr.enabled, false); assert.equal(w.entry("WEB_REMIX").sabr.osName, "Windows");
  assert.deepEqual(w.live(), ["WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY"], "chain untouched");
  const back = () => ({ clients: [{ key: "WEB_REMIX", main: true, sabr: "benched", results: whole(), sabrResults: whole() }, ...dying().clients.slice(1)] });
  run(w, back()); const r4 = run(w, back());
  assert.deepEqual(r4.applied, ["sabr-unbench:WEB_REMIX"]);
  assert.equal(w.entry("WEB_REMIX").sabr.enabled, undefined);
  assert.deepEqual(w.entry("WEB_REMIX").sabr, { osName: "Windows", osVersion: "10.0" });
});

test("FUTURE: a benched fallback comes back - un-benched in its original chain position", () => {
  const w = world(TABLE_TODAY);
  const dead = () => ({ clients: [...healthyClients(["WEB_REMIX", "VISIONOS"]), { key: "VISIONOS_0_1", results: all("partial") }, ...healthyClients(["WEB_CREATOR", "TVHTML5_SIMPLY"]).map((c) => ({ ...c, main: false }))] });
  run(w, dead()); run(w, dead());
  assert.deepEqual(w.live(), ["WEB_REMIX", "VISIONOS", "WEB_CREATOR", "TVHTML5_SIMPLY"]);
  const alive = () => ({ clients: [...healthyClients(["WEB_REMIX", "VISIONOS"]), { key: "VISIONOS_0_1", role: "benched", results: whole() }, ...healthyClients(["WEB_CREATOR", "TVHTML5_SIMPLY"]).map((c) => ({ ...c, main: false }))] });
  const r3 = run(w, alive()); assert.deepEqual(r3.revived, ["VISIONOS_0_1"]); assert.deepEqual(r3.applied, []);
  const r4 = run(w, alive()); assert.deepEqual(r4.applied, ["unbench:VISIONOS_0_1"]);
  assert.deepEqual(w.live(), ["WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY"]);
  assert.equal(w.table, TABLE_TODAY, "byte-identical after the round trip");
});

test("FUTURE: a retired client works again - an issue for a human, the table untouched; a bump on a benched entry waits until it is un-benched", () => {
  const w = world(TABLE_TODAY);
  const r = run(w, { clients: [...healthyClients(["WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY"]), { key: "IOS", role: "retired", results: whole() }, { key: "MWEB", role: "retired", results: all("partial") }] });
  assert.deepEqual(r.resurrected, ["IOS"]); assert.deepEqual(r.applied, []); assert.equal(w.table, TABLE_TODAY);
  // Bench WEB_CREATOR, then a verified bump for it arrives: refused while benched, applied after un-bench.
  const dead = () => ({ clients: [...healthyClients(["WEB_REMIX", "VISIONOS", "VISIONOS_0_1"]), { key: "WEB_CREATOR", results: all("http-error") }, ...healthyClients(["TVHTML5_SIMPLY"]).map((c) => ({ ...c, main: false }))] });
  run(w, dead()); run(w, dead());
  const rb = run(w, { clients: dead().clients.filter((c) => c.key !== "WEB_CREATOR") }, { bumps: [{ key: "WEB_CREATOR", fields: { clientVersion: "9.9" } }] });
  assert.ok(rb.applied[0].startsWith("bump-refused:WEB_CREATOR"), rb.applied.join());
  const alive = () => ({ clients: [...healthyClients(["WEB_REMIX", "VISIONOS", "VISIONOS_0_1"]), { key: "WEB_CREATOR", role: "benched", results: whole() }, ...healthyClients(["TVHTML5_SIMPLY"]).map((c) => ({ ...c, main: false }))] });
  run(w, alive()); run(w, alive());
  const rb2 = run(w, { clients: healthyClients(["WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY"]) }, { bumps: [{ key: "WEB_CREATOR", fields: { clientVersion: "9.9" } }] });
  assert.deepEqual(rb2.applied, ["bump:WEB_CREATOR"]); assert.equal(w.entry("WEB_CREATOR").clientVersion, "9.9");
});

test("FUTURE: yt-dlp rewrites a client's whole identity - a multi-field bump lands in place, nothing else moves", () => {
  const w = world(TABLE_TODAY);
  const fields = { clientVersion: "2.0", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 16_0) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15", osName: "visionOS", osVersion: "27.0.1", deviceMake: "Apple", deviceModel: "RealityDevice18,1" };
  const r = run(w, { clients: healthyClients(["WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY"], ["WEB_REMIX", "VISIONOS", "TVHTML5_SIMPLY"]) }, { bumps: [{ key: "VISIONOS", fields }] });
  assert.deepEqual(r.applied, ["bump:VISIONOS"]);
  const v = w.entry("VISIONOS");
  for (const [f, val] of Object.entries(fields)) assert.equal(v[f], val, f);
  assert.deepEqual(v.sabr, {}); assert.equal(v.mirrors, "visionos"); assert.equal(v.protocol, "web_cipher_pot");
  assert.equal(w.entry("VISIONOS_0_1").clientVersion, "1.0", "the pinned second chance is untouched");
});

test("FUTURE: a flapping client (dead, healthy, dead) never reaches the quorum - only two CONSECUTIVE sightings bench", () => {
  const w = world(TABLE_TODAY);
  const with_ = (kind) => ({ clients: [...healthyClients(["WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "WEB_CREATOR"]), { key: "TVHTML5_SIMPLY", results: all(kind) }] });
  run(w, with_("partial")); run(w, with_("whole")); const r = run(w, with_("partial"));
  assert.deepEqual(r.applied, []); assert.match(r.refused[0], /first sighting/);
  const r4 = run(w, with_("partial")); assert.deepEqual(r4.applied, ["bench:TVHTML5_SIMPLY"]);
});

// =========================================================================== MULTI-SLOT ======
const slotScan = (perClient) => ({ videos: ["v0", "v1"], clients: Object.entries(perClient).map(([key, kinds], i) => ({ key, main: i === 0, loginSupported: key === "WEB_REMIX" || key === "WEB_CREATOR", loginRequired: key === "WEB_CREATOR", sabr: ["WEB_REMIX", "VISIONOS", "TVHTML5_SIMPLY"].includes(key) ? "live" : null, results: kinds.map((k, j) => ({ video: `v${j}`, kind: k })), sabrResults: [] })) });
const healthyAll = { WEB_REMIX: ["whole", "whole"], VISIONOS: ["whole", "whole"], VISIONOS_0_1: ["whole", "whole"], WEB_CREATOR: ["whole", "whole"], TVHTML5_SIMPLY: ["whole", "whole"] };

test("MULTI-SLOT: a real kill seen by five slots is not vetoed by one slot's transport error - benched on the second run", () => {
  const w = world(TABLE_TODAY);
  const kill = { ...healthyAll, TVHTML5_SIMPLY: ["partial", "partial"] };
  const slots = () => [...Array(5)].map(() => slotScan(kill)).concat([slotScan({ ...healthyAll, TVHTML5_SIMPLY: ["error", "partial"] })]);
  const r1 = run(w, mergeScans(slots())); assert.deepEqual(r1.dead, ["TVHTML5_SIMPLY"]);
  const r2 = run(w, mergeScans(slots())); assert.deepEqual(r2.applied, ["bench:TVHTML5_SIMPLY"]);
});

test("MULTI-SLOT: one slot's egress artifact (every anonymous client walled) is outvoted by clean slots - nothing dead, nothing benched", () => {
  const w = world(TABLE_TODAY);
  const walled = { ...healthyAll, VISIONOS: ["partial", "partial"], VISIONOS_0_1: ["partial", "partial"], TVHTML5_SIMPLY: ["partial", "partial"] };
  const slots = () => [slotScan(walled), slotScan(healthyAll), slotScan(healthyAll)];
  for (let i = 0; i < 3; i++) { const r = run(w, mergeScans(slots())); assert.deepEqual(r.dead, []); assert.deepEqual(r.applied, []); }
  assert.equal(w.table, TABLE_TODAY);
});

test("MULTI-SLOT: a lone failing slot against silence (others errored) stays inconclusive - no false kill from one bad egress", () => {
  const w = world(TABLE_TODAY);
  const slots = () => [slotScan({ ...healthyAll, WEB_CREATOR: ["partial", "partial"] }), slotScan({ ...healthyAll, WEB_CREATOR: ["error", "error"] }), slotScan({ ...healthyAll, WEB_CREATOR: ["error", "error"] })];
  run(w, mergeScans(slots())); const r = run(w, mergeScans(slots()));
  assert.deepEqual(r.dead, []); assert.deepEqual(r.applied, []); assert.deepEqual(r.inconclusive, ["WEB_CREATOR"]);
});
