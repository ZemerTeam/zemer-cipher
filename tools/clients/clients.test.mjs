// Regression tests for the pure decision + write logic behind the automated stream-client bench.
// No network, no credentials:  node --test tools/clients/clients.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classify, classifySabr, planBenches, planUnbenches, planSabrBenches, issueTitle, ISSUE_TITLE_RE, revivedTitle, REVIVED_TITLE_RE, driftTitle, sabrIssueTitle, sabrRevivedTitle } from "./decide.mjs";
import { benchEntryText, verifyBench, unbenchEntryText, verifyUnbench, benchSabrText, unbenchSabrText, verifySabrToggle } from "./apply-bench.mjs";
import { bumpEntryText, verifyBump } from "./apply-bump.mjs";

const r = (video, kind, reason = "") => ({ video, kind, reason });
const scan = (conclusive, clients) => ({ conclusive, clients });

test("classify: one whole song anywhere is healthy; all-definitive failures are dead; else inconclusive", () => {
  const s = scan(true, [
    { key: "WEB_REMIX", family: "WEB_REMIX", main: true, results: [r("a", "whole"), r("b", "partial", "403 after 1024KB")] },
    { key: "VISIONOS", family: "VISIONOS", results: [r("a", "partial", "403 after 0KB"), r("b", "sabr-only")] },
    { key: "WEB_CREATOR", family: "WEB_CREATOR", results: [r("a", "skipped-login"), r("b", "skipped-login")] },
    { key: "TVHTML5_SIMPLY", family: "TVHTML5", results: [r("a", "error", "ECONNRESET"), r("b", "not-ok")] },
  ]);
  const c = classify(s);
  assert.deepEqual(c.healthy.map((x) => x.key), ["WEB_REMIX"]);
  assert.deepEqual(c.dead.map((x) => x.key), ["VISIONOS"]);
  assert.deepEqual(c.inconclusive.map((x) => x.key), ["WEB_CREATOR", "TVHTML5_SIMPLY"]);
  assert.equal(c.dead[0].reasons[0], "a: partial (403 after 0KB)");
});

test("classify: an inconclusive scan (main never drained) declares nothing dead", () => {
  const s = scan(false, [
    { key: "WEB_REMIX", main: true, results: [r("a", "partial")] },
    { key: "VISIONOS", results: [r("a", "partial")] },
  ]);
  const c = classify(s);
  assert.deepEqual(c.dead, []);
  assert.deepEqual(c.inconclusive.map((x) => x.key), ["WEB_REMIX", "VISIONOS"]);
});

test("classify: a client with no results is inconclusive, not dead", () => {
  const c = classify(scan(true, [{ key: "WEB_REMIX", main: true, results: [r("a", "whole")] }, { key: "X", results: [] }]));
  assert.deepEqual(c.inconclusive.map((x) => x.key), ["X"]);
});

const LIVE = ["WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY"];
const dead = (...keys) => keys.map((key) => ({ key, family: key, main: key === "WEB_REMIX", reasons: [] }));

test("planBenches: only a previously flagged, non-main, live entry is benched", () => {
  const p = planBenches({ liveKeys: LIVE, dead: dead("VISIONOS_0_1", "WEB_CREATOR", "GHOST"), previouslyFlagged: ["VISIONOS_0_1"] });
  assert.deepEqual(p.bench, ["VISIONOS_0_1"]);
  assert.deepEqual(p.refused.map((x) => x.key), ["WEB_CREATOR", "GHOST"]);
  assert.match(p.refused[0].reason, /first sighting/);
  assert.match(p.refused[1].reason, /not a live/);
});

test("planBenches: the main client is never benched, even when flagged", () => {
  const p = planBenches({ liveKeys: LIVE, dead: dead("WEB_REMIX"), previouslyFlagged: ["WEB_REMIX"] });
  assert.deepEqual(p.bench, []);
  assert.match(p.refused[0].reason, /main client/);
});

test("planBenches: never below the minimum live fallbacks, counting benches made this run", () => {
  const all = ["VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY"];
  const p = planBenches({ liveKeys: LIVE, dead: dead(...all), previouslyFlagged: all });
  // 4 live fallbacks: two may go, the third would leave 1 (< 2), the fourth likewise.
  assert.deepEqual(p.bench, ["VISIONOS", "VISIONOS_0_1"]);
  assert.deepEqual(p.refused.map((x) => x.key), ["WEB_CREATOR", "TVHTML5_SIMPLY"]);
  assert.match(p.refused[0].reason, /minimum 2/);
  const strict = planBenches({ liveKeys: ["MAIN", "A", "B"], dead: dead("A"), previouslyFlagged: ["A"], minLiveFallbacks: 2 });
  assert.deepEqual(strict.bench, []);
});

test("classify: benched and retired roles never count as dead; a whole song revives/resurrects them", () => {
  const c = classify(scan(true, [
    { key: "WEB_REMIX", main: true, results: [r("a", "whole")] },
    { key: "VISIONOS_0_1", role: "benched", results: [r("a", "whole")] },
    { key: "WEB_CREATOR", role: "benched", results: [r("a", "partial")] },
    { key: "MWEB", role: "retired", results: [r("a", "whole")] },
    { key: "IOS", role: "retired", results: [r("a", "partial"), r("b", "not-ok")] },
  ]));
  assert.deepEqual(c.dead, []);
  assert.deepEqual(c.revived.map((x) => x.key), ["VISIONOS_0_1"]);
  assert.deepEqual(c.resurrected.map((x) => x.key), ["MWEB"]);
  assert.deepEqual(c.stillDead.map((x) => x.key), ["WEB_CREATOR", "IOS"]);
});

test("planUnbenches: only a previously flagged revival is un-benched", () => {
  const revived = [{ key: "A" }, { key: "B" }];
  const p = planUnbenches({ revived, previouslyFlagged: ["B"] });
  assert.deepEqual(p.unbench, ["B"]);
  assert.deepEqual(p.refused.map((x) => x.key), ["A"]);
});

test("issue titles have ONE definition: the workflow imports decide.mjs, issues.cjs uses its helpers, notify's shell cases match", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const yml = readFileSync(join(root, ".github", "workflows", "client-monitor.yml"), "utf8");
  const cjs = readFileSync(join(root, "tools", "clients", "issues.cjs"), "utf8");
  assert.ok(yml.includes("tools/clients/decide.mjs"), "flagged reader imports decide.mjs");
  assert.ok(yml.includes("tools/clients/issues.cjs"), "issue steps use issues.cjs");
  assert.ok(!/Stream client failing: \$\{/.test(yml) && !/Stream client revived: \$\{/.test(yml), "no inline upsert titles left in the workflow");
  for (const fn of ["issueTitle", "revivedTitle", "resurrectedTitle", "driftTitle", "INCONCLUSIVE_TITLE"]) assert.ok(cjs.includes(`decide.${fn}`), `issues.cjs uses decide.${fn}`);
  assert.ok(!cjs.includes("Stream client failing:"), "issues.cjs carries no literal titles");
  // The notify job's shell `case` patterns are the one remaining copy: pin them to the exports.
  assert.ok(yml.includes(`"${issueTitle("")}"*)`), "notify failing case");
  assert.ok(yml.includes(`"${revivedTitle("")}"*)`), "notify revived case");
  assert.ok(yml.includes(`"${driftTitle("")}"*)`), "notify drift case");
  assert.ok(yml.includes(`"${sabrIssueTitle("")}"*)`) && yml.includes(`"${sabrRevivedTitle("")}"*)`), "notify SABR cases");
});

test("classifySabr: only live sabr entries; dead needs sabrConclusive; benched revives on a whole song", () => {
  const s = { sabrConclusive: true, clients: [
    { key: "WEB_REMIX", sabr: "live", sabrResults: [r("a", "whole")] },
    { key: "VISIONOS", sabr: "live", sabrResults: [r("a", "partial", "capped 6/34"), r("b", "sabr-error")] },
    { key: "TVHTML5_SIMPLY", sabr: "live", sabrResults: [r("a", "partial"), r("b", "bot-gated")] },
    { key: "WEB_CREATOR", sabr: null, sabrResults: [] },
    { key: "OLD", sabr: "benched", sabrResults: [r("a", "whole")] },
    { key: "OLD2", sabr: "benched", sabrResults: [r("a", "no-sabr")] },
    { key: "RET", role: "retired", sabr: "live", sabrResults: [r("a", "partial")] },
  ] };
  const c = classifySabr(s);
  assert.deepEqual(c.sabrHealthy.map((x) => x.key), ["WEB_REMIX"]);
  assert.deepEqual(c.sabrDead.map((x) => x.key), ["VISIONOS"]);
  assert.deepEqual(c.sabrInconclusive.map((x) => x.key), ["TVHTML5_SIMPLY"]);
  assert.deepEqual(c.sabrRevived.map((x) => x.key), ["OLD"]);
  assert.deepEqual(c.sabrStillDead.map((x) => x.key), ["OLD2"]);
  assert.deepEqual(classifySabr({ ...s, sabrConclusive: false }).sabrDead, []);
  const p = planSabrBenches({ sabrDead: c.sabrDead, previouslyFlagged: [] });
  assert.deepEqual(p.bench, []); assert.match(p.refused[0].reason, /first sighting/);
  assert.deepEqual(planSabrBenches({ sabrDead: c.sabrDead, previouslyFlagged: ["VISIONOS"] }).bench, ["VISIONOS"]);
});

const STABLE = `{
  "schemaVersion": 1,
  "clients": [
    {
      "key": "WEB_REMIX",
      "clientName": "WEB_REMIX",
      "protocol": "web_cipher_pot",
      "family": "WEB_REMIX",
      "sabr": { "osName": "Windows", "osVersion": "10.0" }
    },
    {
      "key": "VISIONOS",
      "clientName": "VISIONOS",
      "protocol": "direct",
      "family": "VISIONOS",
      "sabr": {}
    },
    {
      "key": "TVHTML5_SIMPLY",
      "clientName": "TVHTML5_SIMPLY",
      "protocol": "web_cipher_pot",
      "family": "TVHTML5",
      "sabr": {
        "osName": "Cobalt"
      }
    },
    {
      "key": "WEB_CREATOR",
      "clientName": "WEB_CREATOR",
      "protocol": "web_cipher_pot",
      "family": "WEB_CREATOR"
    }
  ]
}
`;
const sParse = (text) => { const d = JSON.parse(text); return { clients: d.clients.filter((c) => c.enabled !== false), skipped: [] }; };

test("SABR bench/un-bench round-trips on one-line, empty and multi-line sabr objects; identity kept; never the chain", () => {
  for (const key of ["WEB_REMIX", "VISIONOS", "TVHTML5_SIMPLY"]) {
    const b = benchSabrText(STABLE, key);
    assert.equal(b.changed, true, key);
    const parsed = JSON.parse(b.text).clients.find((c) => c.key === key);
    assert.equal(parsed.sabr.enabled, false, key);
    verifySabrToggle(STABLE, b.text, key, sParse, true);
    assert.equal(benchSabrText(b.text, key).changed, false, "idempotent");
    const u = unbenchSabrText(b.text, key);
    assert.equal(u.changed, true, key);
    assert.deepEqual(JSON.parse(u.text), JSON.parse(STABLE), `${key} round-trips semantically`);
    verifySabrToggle(b.text, u.text, key, sParse, false);
    assert.equal(unbenchSabrText(STABLE, key).changed, false);
  }
  assert.equal(JSON.parse(benchSabrText(STABLE, "WEB_REMIX").text).clients[0].sabr.osName, "Windows", "identity overrides survive a bench");
  assert.throws(() => benchSabrText(STABLE, "WEB_CREATOR"), /no sabr object/);
  // The chain never changes: a SABR bench is not an entry bench.
  assert.deepEqual(sParse(benchSabrText(STABLE, "VISIONOS").text).clients.map((c) => c.key), ["WEB_REMIX", "VISIONOS", "TVHTML5_SIMPLY", "WEB_CREATOR"]);
  // verify refuses a tampered identity or a second entry.
  const tampered = benchSabrText(STABLE, "WEB_REMIX").text.replace('"osVersion": "10.0"', '"osVersion": "11"');
  assert.throws(() => verifySabrToggle(STABLE, tampered, "WEB_REMIX", sParse, true), /identity overrides changed/);
});

test("issue titles round-trip through the dedup regex", () => {
  assert.equal(revivedTitle("X").match(REVIVED_TITLE_RE)[1], "X");
  const m = issueTitle("TVHTML5_SIMPLY").match(ISSUE_TITLE_RE);
  assert.equal(m[1], "TVHTML5_SIMPLY");
  assert.equal("Stream client failing: bad key".match(ISSUE_TITLE_RE), null);
});

const TABLE = `{
  "schemaVersion": 1,
  "clients": [
    {
      "key": "WEB_REMIX",
      "clientName": "WEB_REMIX",
      "protocol": "web_cipher_pot",
      "family": "WEB_REMIX"
    },
    {
      "key": "VISIONOS",
      "clientName": "VISIONOS",
      "protocol": "direct",
      "family": "VISIONOS"
    },
    {
      "key": "VISIONOS_0_1",
      "clientName": "VISIONOS",
      "protocol": "direct",
      "family": "VISIONOS"
    },
    {
      "key": "TVHTML5_SIMPLY",
      "clientName": "TVHTML5_SIMPLY",
      "protocol": "web_cipher_pot",
      "family": "TVHTML5"
    }
  ],
  "families": [
    { "id": "WEB_REMIX", "title": "YouTube Music Web", "group": "web" }
  ]
}
`;

// A loader stub with the harness loader's shape: live clients in order, disabled keys in `skipped`.
const stubParse = (text) => {
  const d = JSON.parse(text);
  return {
    clients: d.clients.filter((c) => c.enabled !== false),
    skipped: d.clients.filter((c) => c.enabled === false).map((c) => c.key),
  };
};

test("benchEntryText inserts exactly one kill-switch line after the key line, same indentation", () => {
  const { text, changed } = benchEntryText(TABLE, "VISIONOS_0_1");
  assert.equal(changed, true);
  const before = TABLE.split("\n"), after = text.split("\n");
  assert.equal(after.length, before.length + 1);
  const at = after.indexOf('      "key": "VISIONOS_0_1",');
  assert.equal(after[at + 1], '      "enabled": false,');
  assert.deepEqual(stubParse(text).skipped, ["VISIONOS_0_1"]);
  assert.deepEqual(stubParse(text).clients.map((c) => c.key), ["WEB_REMIX", "VISIONOS", "TVHTML5_SIMPLY"]);
});

test("benchEntryText is a no-op on an entry that already carries an enabled flag", () => {
  const once = benchEntryText(TABLE, "VISIONOS_0_1").text;
  const twice = benchEntryText(once, "VISIONOS_0_1");
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once);
});

test("unbench handles a hand-written kill switch: no space, no trailing comma (last field), after a sabr block", () => {
  const lastField = TABLE.replace('      "family": "VISIONOS"\n    },\n    {\n      "key": "TVHTML5', '      "family": "VISIONOS",\n      "enabled":false\n    },\n    {\n      "key": "TVHTML5');
  assert.deepEqual(stubParse(lastField).skipped, ["VISIONOS_0_1"]);
  const back = unbenchEntryText(lastField, "VISIONOS_0_1");
  assert.equal(back.changed, true);
  assert.equal(back.text, TABLE);
  verifyUnbench(lastField, back.text, "VISIONOS_0_1", stubParse);

  const withSabr = TABLE.replace('      "key": "VISIONOS",\n', '      "key": "VISIONOS",\n      "sabr": {\n        "osName": "visionOS"\n      },\n      "enabled": false,\n');
  assert.deepEqual(stubParse(withSabr).skipped, ["VISIONOS"]);
  assert.equal(benchEntryText(withSabr, "VISIONOS").changed, false, "already benched behind a sabr block");
  const again = unbenchEntryText(withSabr, "VISIONOS");
  assert.equal(again.changed, true);
  assert.deepEqual(stubParse(again.text).skipped, []);
});

test("benchEntryText refuses an unknown or ambiguous key", () => {
  assert.throws(() => benchEntryText(TABLE, "NOPE"), /found 0/);
  assert.throws(() => benchEntryText(TABLE, "VISION.*"), /invalid key/);
  assert.throws(() => unbenchEntryText(TABLE, ""), /invalid key/);
  assert.throws(() => benchEntryText(TABLE + TABLE, "VISIONOS"), /found 2/);
});

test("verifyBench accepts the canonical edit and reports the chains", () => {
  const after = benchEntryText(TABLE, "VISIONOS_0_1").text;
  const v = verifyBench(TABLE, after, "VISIONOS_0_1", stubParse);
  assert.deepEqual(v.liveAfter, ["WEB_REMIX", "VISIONOS", "TVHTML5_SIMPLY"]);
});

test("unbenchEntryText removes exactly the kill-switch line and verifyUnbench accepts it", () => {
  const benched = benchEntryText(TABLE, "VISIONOS_0_1").text;
  const back = unbenchEntryText(benched, "VISIONOS_0_1");
  assert.equal(back.changed, true);
  assert.equal(back.text, TABLE);
  const v = verifyUnbench(benched, back.text, "VISIONOS_0_1", stubParse);
  assert.deepEqual(v.liveAfter, ["WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "TVHTML5_SIMPLY"]);
  assert.equal(unbenchEntryText(TABLE, "VISIONOS_0_1").changed, false);
  assert.throws(() => verifyUnbench(TABLE, TABLE.replace('      "protocol": "direct",\n      "family": "VISIONOS"\n    },\n    {\n      "key": "VISIONOS_0_1"', '      "family": "VISIONOS"\n    },\n    {\n      "key": "VISIONOS_0_1"'), "VISIONOS", stubParse), /not the kill switch/);
});

const VTABLE = `{
  "schemaVersion": 1,
  "clients": [
    {
      "key": "WEB_REMIX",
      "clientName": "WEB_REMIX",
      "clientVersion": "1.20260213.01.00",
      "clientId": "67",
      "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
      "protocol": "web_cipher_pot",
      "family": "WEB_REMIX",
      "mirrors": "web_music",
      "loginSupported": true,
      "skipHeadValidation": true
    },
    {
      "key": "VISIONOS",
      "clientName": "VISIONOS",
      "clientVersion": "1.02",
      "clientId": "101",
      "userAgent": "Mozilla/5.0 (Macintosh)",
      "protocol": "direct",
      "family": "VISIONOS"
    }
  ]
}
`;
const vParse = (text) => {
  const d = JSON.parse(text);
  return { clients: d.clients.filter((c) => c.enabled !== false), skipped: d.clients.filter((c) => c.enabled === false).map((c) => c.key) };
};

test("bumpEntryText replaces an identity field in place and inserts a missing one after clientVersion", () => {
  const { text, changed, applied } = bumpEntryText(VTABLE, "WEB_REMIX", { clientVersion: "1.20260707.12.00" });
  assert.equal(changed, true);
  assert.deepEqual(applied, { clientVersion: "1.20260707.12.00" });
  assert.equal(text.split("\n").length, VTABLE.split("\n").length);
  assert.match(text, /"clientVersion": "1.20260707.12.00",/);
  const v = verifyBump(VTABLE, text, "WEB_REMIX", { clientVersion: "1.20260707.12.00" }, vParse);
  assert.deepEqual(v.changes, { clientVersion: { from: "1.20260213.01.00", to: "1.20260707.12.00" } });

  const ins = bumpEntryText(VTABLE, "VISIONOS", { osName: "visionOS", osVersion: "26.5.23O471" });
  const lines = ins.text.split("\n");
  const cv = lines.indexOf('      "clientVersion": "1.02",');
  assert.deepEqual(lines.slice(cv + 1, cv + 3), ['      "osName": "visionOS",', '      "osVersion": "26.5.23O471",']);
  assert.deepEqual(verifyBump(VTABLE, ins.text, "VISIONOS", { osName: "visionOS", osVersion: "26.5.23O471" }, vParse).changes,
    { osName: { from: null, to: "visionOS" }, osVersion: { from: null, to: "26.5.23O471" } });
});

test("bumpEntryText keeps JSON valid when clientVersion is the entry's last field, and refuses regex-unsafe keys", () => {
  const lastField = `{\n  "schemaVersion": 1,\n  "clients": [\n    {\n      "key": "A",\n      "clientName": "A",\n      "clientId": "1",\n      "userAgent": "ua",\n      "protocol": "direct",\n      "family": "A",\n      "clientVersion": "1.0"\n    }\n  ]\n}\n`;
  const one = bumpEntryText(lastField, "A", { osName: "X" });
  assert.equal(JSON.parse(one.text).clients[0].osName, "X");
  const two = bumpEntryText(lastField, "A", { osName: "X", osVersion: "2" });
  const c = JSON.parse(two.text).clients[0];
  assert.equal(c.osName, "X"); assert.equal(c.osVersion, "2"); assert.equal(c.clientVersion, "1.0");
  assert.throws(() => bumpEntryText(lastField, "A|B", { osName: "X" }), /invalid key/);
  assert.throws(() => bumpEntryText(lastField, "a", { osName: "X" }), /invalid key/);
  // CRLF files survive too.
  const crlf = bumpEntryText(lastField.replace(/\n/g, "\r\n"), "A", { clientVersion: "2.0" });
  assert.equal(JSON.parse(crlf.text).clients[0].clientVersion, "2.0");
});

test("bumpEntryText is a no-op at the target values and refuses non-identity or invalid fields", () => {
  assert.equal(bumpEntryText(VTABLE, "VISIONOS", { clientVersion: "1.02" }).changed, false);
  assert.throws(() => bumpEntryText(VTABLE, "VISIONOS", { clientId: "5" }), /not an identity field/);
  assert.throws(() => bumpEntryText(VTABLE, "VISIONOS", { protocol: "direct" }), /not an identity field/);
  assert.throws(() => bumpEntryText(VTABLE, "VISIONOS", { clientVersion: "bad version!" }), /invalid clientVersion/);
  assert.throws(() => bumpEntryText(VTABLE, "VISIONOS", { userAgent: "evil\r\nX: 1" }), /invalid userAgent/);
});

test("verifyBump refuses a touched other entry, an unrequested field, and a wrong value", () => {
  const good = bumpEntryText(VTABLE, "WEB_REMIX", { clientVersion: "1.20260707.12.00" }).text;
  assert.throws(() => verifyBump(VTABLE, good.replace('"clientVersion": "1.02"', '"clientVersion": "1.03"'), "WEB_REMIX", { clientVersion: "1.20260707.12.00" }, vParse), /VISIONOS changed/);
  assert.throws(() => verifyBump(VTABLE, good.replace('"skipHeadValidation": true', '"skipHeadValidation": false'), "WEB_REMIX", { clientVersion: "1.20260707.12.00" }, vParse), /non-identity/);
  assert.throws(() => verifyBump(VTABLE, good, "WEB_REMIX", { clientVersion: "9.9" }, vParse), /expected "9.9"/);
  const extra = bumpEntryText(good, "WEB_REMIX", { osName: "Windows" }).text;
  assert.throws(() => verifyBump(VTABLE, extra, "WEB_REMIX", { clientVersion: "1.20260707.12.00" }, vParse), /not requested/);
});

test("verifyBench refuses the main, a second changed line, a wrong inserted line, and too few fallbacks", () => {
  assert.throws(() => verifyBench(TABLE, benchEntryText(TABLE, "WEB_REMIX").text, "WEB_REMIX", stubParse), /main client/);
  const tampered = benchEntryText(TABLE, "VISIONOS_0_1").text.replace('"protocol": "direct",\n      "family": "VISIONOS"\n    },\n    {\n      "key": "TVHTML5', '"protocol": "web_cipher_pot",\n      "family": "VISIONOS"\n    },\n    {\n      "key": "TVHTML5');
  assert.throws(() => verifyBench(TABLE, tampered, "VISIONOS_0_1", stubParse), /changed besides/);
  const wrongLine = TABLE.replace('"key": "VISIONOS_0_1",', '"key": "VISIONOS_0_1",\n      "userAgent": "x",');
  assert.throws(() => verifyBench(TABLE, wrongLine, "VISIONOS_0_1", stubParse), /not the kill switch/);
  const after = benchEntryText(TABLE, "VISIONOS_0_1").text;
  assert.throws(() => verifyBench(TABLE, after, "VISIONOS_0_1", stubParse, { minLiveFallbacks: 3 }), /minimum 3/);
});
