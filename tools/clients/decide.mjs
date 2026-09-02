// The pure decision logic of the stream-client monitor: which clients a scan proves DEAD, and which
// of those the pipeline may BENCH unattended. No network, no filesystem — every rule here is
// unit-tested (clients.test.mjs), because a wrong bench is a fleet-wide playback change within
// hours and a missed one is the kill the whole table exists to survive.
//
// Input is tests/scan-stream-clients.mjs output (zemer-app harness): one drain verdict per client
// per validation video over a DYNAMIC roster — `role` in
//   live      a table entry: all-definitive failures = DEAD (bench on the 2nd consecutive run)
//   benched   a table entry under `enabled: false`: a whole song = REVIVED (un-bench, 2nd run)
//   retired   a client the app removed (tests/clients-retired.mjs): a whole song = RESURRECTED
//             (alert only — re-adding a client is a human's validated table change, never automatic)
// and `kind` in
//   whole                                  success — the client streams the whole song
//   partial | sabr-only | no-format | not-ok | http-error
//                                          definitive failure — the app would fail identically
//   error | skipped-login                  INCONCLUSIVE — transport hiccup / no cookie for a
//                                          login-required client; says nothing about the client

/** Verdict kinds that prove the client cannot serve the app right now (progressive drain). */
export const DEFINITIVE_FAILURES = new Set(["partial", "sabr-only", "no-format", "not-ok", "http-error"]);
/** The same for the SABR drain (tests/sabr-clients.mjs): a capped or errored session, or no SABR path at all. */
export const SABR_DEFINITIVE_FAILURES = new Set(["partial", "sabr-error", "no-sabr", "no-format", "not-ok", "http-error"]);

/**
 * Classify a scan. A LIVE client is DEAD only when the scan is conclusive (SOME client drained a
 * whole song somewhere, so the runner/cookie/cipher are known-good) AND every one of its results
 * is a definitive failure on every validation video. One whole song anywhere = healthy. Anything
 * with an inconclusive result and no success = inconclusive, never dead. A BENCHED entry that
 * drained a whole song is `revived`; a RETIRED client that did is `resurrected`. Non-live entries
 * that keep failing are simply `stillDead` (no action, no alert — that is their expected state).
 */
export function classify(scan) {
  const out = { conclusive: Boolean(scan?.conclusive), dead: [], healthy: [], inconclusive: [], revived: [], resurrected: [], stillDead: [] };
  for (const c of scan?.clients || []) {
    const results = c.results || [];
    const role = c.role || "live";
    const entry = { key: c.key, family: c.family, role, main: Boolean(c.main), reasons: results.map((r) => `${r.video}: ${r.kind}${r.reason ? " (" + r.reason + ")" : ""}`) };
    const whole = results.some((r) => r.kind === "whole");
    // Revival / resurrection are STRICT: whole on EVERY validation video. An ungated video (the
    // 2026-09-01 sweep: dQw4w9WgXcQ streams whole for IOS, MWEB, even ANDROID_VR) must never
    // un-bench a client that is still walled on gated content, nor open "works again" issues
    // for retired clients every run.
    const everyWhole = results.length > 0 && results.every((r) => r.kind === "whole");
    if (role !== "live") {
      if (everyWhole) (role === "benched" ? out.revived : out.resurrected).push(entry);
      else out.stillDead.push(entry);
      continue;
    }
    if (whole) out.healthy.push(entry);
    else if (out.conclusive && results.length > 0 && results.every((r) => DEFINITIVE_FAILURES.has(r.kind))) out.dead.push(entry);
    else out.inconclusive.push(entry);
  }
  return out;
}

/**
 * Classify the SABR pass. Only LIVE table entries that carry a `sabr` object take part:
 *   sabr "live"    all-definitive SABR failures on every video (scan sabrConclusive) = sabrDead;
 *                  a whole song anywhere = sabrHealthy
 *   sabr "benched" (`sabr.enabled: false`) a whole song anywhere = sabrRevived
 * The SABR capability is benched/un-benched with the SAME two-run quorum as the chain (issues
 * "Stream client SABR failing/revived: KEY"), and only ever the `sabr.enabled` flag changes —
 * the entry keeps streaming progressively and keeps its SABR identity overrides.
 */
export function classifySabr(scan) {
  const out = { conclusive: Boolean(scan?.sabrConclusive), sabrDead: [], sabrHealthy: [], sabrInconclusive: [], sabrRevived: [], sabrStillDead: [] };
  for (const c of scan?.clients || []) {
    if ((c.role || "live") !== "live" || !c.sabr) continue;
    const results = c.sabrResults || [];
    const entry = { key: c.key, family: c.family, reasons: results.map((r) => `${r.video}: ${r.kind}${r.reason ? " (" + r.reason + ")" : ""}`) };
    const whole = results.some((r) => r.kind === "whole");
    const everyWhole = results.length > 0 && results.every((r) => r.kind === "whole");
    if (c.sabr === "benched") { (everyWhole ? out.sabrRevived : out.sabrStillDead).push(entry); continue; }
    // An entry that is failing PROGRESSIVELY on every video is not a SABR verdict: its /player
    // is what is broken (a dead main, a retired version). That is the chain's business (bench /
    // human / bump) - toggling its SABR flag on top would be noise, so it stays inconclusive here.
    const progressive = c.results || [];
    if (!whole && progressive.length > 0 && progressive.every((r) => DEFINITIVE_FAILURES.has(r.kind))) {
      out.sabrInconclusive.push({ ...entry, reasons: ["entry itself failing progressively - not a SABR verdict"] }); continue;
    }
    if (whole) out.sabrHealthy.push(entry);
    else if (out.conclusive && results.length > 0 && results.every((r) => SABR_DEFINITIVE_FAILURES.has(r.kind))) out.sabrDead.push(entry);
    else out.sabrInconclusive.push(entry);
  }
  return out;
}

/** SABR benches: second consecutive sighting only; no other refusal (no minimum roster — SABR is an opt-in transport). */
export function planSabrBenches({ sabrDead, previouslyFlagged }) {
  const flagged = new Set(previouslyFlagged || []);
  const bench = [], refused = [];
  for (const d of sabrDead) {
    if (flagged.has(d.key)) bench.push(d.key);
    else refused.push({ key: d.key, reason: "SABR: first sighting — benched only on the next run if still failing" });
  }
  return { bench, refused };
}

/**
 * Which revived (benched, now draining whole songs) entries may be UN-benched this run: only on
 * the second consecutive sighting (`previouslyFlagged` = keys whose revival issue was already open
 * before this run). Un-benching restores a previously validated entry, so no other refusal applies.
 */
export function planUnbenches({ revived, previouslyFlagged }) {
  const flagged = new Set(previouslyFlagged || []);
  const unbench = [], refused = [];
  for (const r of revived) {
    if (flagged.has(r.key)) unbench.push(r.key);
    else refused.push({ key: r.key, reason: "first sighting — un-benched only on the next run if still whole" });
  }
  return { unbench, refused };
}

/**
 * Which dead clients may be benched THIS run. Rules, all of them refusals (the pipeline never
 * widens what a human would do):
 *   - never the MAIN client (entry 0): a dead main is a human decision (promote which fallback?)
 *   - only on the SECOND consecutive sighting: `previouslyFlagged` = keys whose detection issue
 *     was already open BEFORE this run started — one scan can be a bad hour at the CDN
 *   - never below `minLiveFallbacks` live non-main entries after the bench: the chain must keep
 *     a real fallback, so a wave of failures degrades to "alert a human", not "bench everything"
 * `liveKeys` = the table's currently enabled entry keys in table order (entry 0 = main).
 */
export function planBenches({ liveKeys, dead, previouslyFlagged, minLiveFallbacks = 2 }) {
  const flagged = new Set(previouslyFlagged || []);
  const bench = [];
  const refused = [];
  const live = new Set(liveKeys);
  const main = liveKeys[0];
  for (const d of dead) {
    if (!live.has(d.key)) { refused.push({ key: d.key, reason: "not a live table entry" }); continue; }
    if (d.key === main) { refused.push({ key: d.key, reason: "main client — needs a human (promote which fallback?)" }); continue; }
    if (!flagged.has(d.key)) { refused.push({ key: d.key, reason: "first sighting — benched only on the next run if still dead" }); continue; }
    const remaining = [...live].filter((k) => k !== main && k !== d.key && !bench.includes(k)).length;
    if (remaining < minLiveFallbacks) { refused.push({ key: d.key, reason: `would leave ${remaining} live fallback(s), minimum ${minLiveFallbacks}` }); continue; }
    bench.push(d.key);
  }
  return { bench, refused };
}

/** Issue titles (dedup keys across runs; the alert and notify jobs share them). */
export const issueTitle = (key) => `Stream client failing: ${key}`;
export const ISSUE_TITLE_RE = /^Stream client failing: ([A-Z0-9_]{1,32})$/;
export const revivedTitle = (key) => `Stream client revived: ${key}`;
export const REVIVED_TITLE_RE = /^Stream client revived: ([A-Z0-9_]{1,32})$/;
export const resurrectedTitle = (key) => `Retired client works again: ${key}`;
export const sabrIssueTitle = (key) => `Stream client SABR failing: ${key}`;
export const SABR_ISSUE_TITLE_RE = /^Stream client SABR failing: ([A-Z0-9_]{1,32})$/;
export const sabrRevivedTitle = (key) => `Stream client SABR revived: ${key}`;
export const SABR_REVIVED_TITLE_RE = /^Stream client SABR revived: ([A-Z0-9_]{1,32})$/;
export const driftTitle = (key) => `Stream client identity drift: ${key}`;
export const INCONCLUSIVE_TITLE = "Stream client scan inconclusive";
