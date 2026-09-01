// Regression tests for the pure decision + write logic behind the automated stream-client bench.
// No network, no credentials:  node --test tools/clients/clients.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { classify, planBenches, planUnbenches, issueTitle, ISSUE_TITLE_RE, revivedTitle, REVIVED_TITLE_RE } from "./decide.mjs";
import { benchEntryText, verifyBench, unbenchEntryText, verifyUnbench } from "./apply-bench.mjs";
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

test("benchEntryText refuses an unknown or ambiguous key", () => {
  assert.throws(() => benchEntryText(TABLE, "NOPE"), /found 0/);
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
