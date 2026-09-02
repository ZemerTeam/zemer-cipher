// node --test tools/clients/merge-slots.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mergeScans } from "./merge-slots.mjs";

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

test("a single slot merges to itself; clients missing from a slot keep the others' evidence", () => {
  const one = scan([{ key: "A", main: true, results: [r("a", "whole")], sabrResults: [] }]);
  assert.deepEqual(mergeScans([one]).clients[0].results.map((x) => x.kind), ["whole"]);
  const m = mergeScans([one, scan([{ key: "A", main: true, results: [r("a", "partial")], sabrResults: [] }, { key: "C", results: [r("a", "partial")], sabrResults: [] }])]);
  assert.deepEqual(m.clients.map((c) => c.key), ["A", "C"]);
  assert.equal(m.clients[0].results[0].kind, "whole"); assert.equal(m.clients[1].results[0].kind, "partial");
  assert.throws(() => mergeScans([]), /no scans/);
});
