// node --test tools/clients/merge-slots.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mergeScans } from "./merge-slots.mjs";
import { missingActions } from "./verify-deploy.mjs";

const r = (video, kind, reason = "") => ({ video, kind, reason });
const scan = (clients, videos = ["a", "b"]) => ({ videos, clients });

test("a whole song from any slot wins; a failure needs every slot to fail; mixed is inconclusive", () => {
  const m = mergeScans([
    scan([{ key: "A", main: true, results: [r("a", "whole"), r("b", "error", "reset")], sabrResults: [r("a", "partial")] },
          { key: "B", results: [r("a", "partial", "403"), r("b", "partial", "403")], sabrResults: [] }]),
    scan([{ key: "A", main: true, results: [r("a", "error", "timeout"), r("b", "whole")], sabrResults: [r("a", "whole")] },
          { key: "B", results: [r("a", "partial", "403"), r("b", "bot-gated")], sabrResults: [] }]),
  ]);
  const A = m.clients.find((c) => c.key === "A"), B = m.clients.find((c) => c.key === "B");
  assert.deepEqual(A.results.map((x) => x.kind), ["whole", "whole"], "each video whole in some slot");
  assert.deepEqual(A.sabrResults.map((x) => x.kind), ["whole"]);
  assert.equal(B.results[0].kind, "partial"); assert.equal(B.results[0].agree, 2, "both slots failed definitively on a");
  assert.equal(B.results[1].kind, "bot-gated"); assert.match(B.results[1].reason, /slots disagree: partial\/bot-gated/);
  assert.equal(m.conclusive, true); assert.equal(m.sabrConclusive, true); assert.equal(m.mainHealthy, true); assert.equal(m.mergedSlots, 2);
});

test("a slot whose post-check failed contributes only its whole songs, never its failures", () => {
  const flipped = { ...scan([{ key: "A", main: true, results: [r("a", "whole"), r("b", "partial", "403 after 0KB")], sabrResults: [r("a", "partial")] }]), postcheckClean: false };
  const clean = scan([{ key: "A", main: true, results: [r("a", "error", "timeout"), r("b", "error", "timeout")], sabrResults: [r("a", "error")] }]);
  const m = mergeScans([flipped, clean]);
  const A = m.clients[0];
  assert.deepEqual(A.results.map((x) => x.kind), ["whole", "error"], "the flipped slot's whole counts, its partial does not");
  assert.equal(A.sabrResults[0].kind, "error");
  assert.equal(m.trustedSlots, 1); assert.equal(m.mergedSlots, 2);
  // A flipped slot alone with only failures merges to no results at all (nothing to judge).
  const only = mergeScans([{ ...scan([{ key: "B", results: [r("a", "partial")], sabrResults: [] }]), postcheckClean: false }]);
  assert.deepEqual(only.clients[0].results, []);
});

test("a single slot merges to itself; clients missing from a slot keep the others' evidence", () => {
  const one = scan([{ key: "A", main: true, results: [r("a", "whole")], sabrResults: [] }]);
  assert.deepEqual(mergeScans([one]).clients[0].results.map((x) => x.kind), ["whole"]);
  const m = mergeScans([one, scan([{ key: "A", main: true, results: [r("a", "partial")], sabrResults: [] }, { key: "C", results: [r("a", "partial")], sabrResults: [] }])]);
  assert.deepEqual(m.clients.map((c) => c.key), ["A", "C"]);
  assert.equal(m.clients[0].results[0].kind, "whole"); assert.equal(m.clients[1].results[0].kind, "partial");
  assert.throws(() => mergeScans([]), /no scans/);
});

test("verify-deploy: every action kind is checked against the read-back table", () => {
  const deployed = { clients: [
    { key: "A" }, { key: "B", enabled: false }, { key: "C", clientVersion: "2.0", userAgent: "ua" },
    { key: "D", sabr: { enabled: false } }, { key: "E", sabr: { osName: "x" } }, { key: "F" },
  ] };
  const bumps = [{ key: "C", fields: { clientVersion: "2.0" } }, { key: "F", fields: { clientVersion: "9" } }];
  assert.deepEqual(missingActions(deployed, bumps, "bench:B unbench:A bump:C sabr-bench:D sabr-unbench:E"), []);
  assert.deepEqual(missingActions(deployed, bumps, "bench:A unbench:B bump:F sabr-bench:E sabr-unbench:D bench:ZZ bump:A weird:A"),
    ["bench:A", "unbench:B", "bump:F", "sabr-bench:E", "sabr-unbench:D", "bench:ZZ", "bump:A", "weird:A"]);
  assert.deepEqual(missingActions({}, [], ""), []);
});
