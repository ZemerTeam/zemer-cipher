import test from "node:test";
import assert from "node:assert/strict";
import { shouldScan } from "./gate.mjs";

const T = "2026-09-02T04:00:00Z";
test("kill switch wins over everything", () => {
  assert.equal(shouldScan({ event: "workflow_dispatch", enabled: "false" }).run, false);
  assert.equal(shouldScan({ event: "push", enabled: "false" }).run, false);
});
test("dispatch and push always scan; chained runs respect the interval", () => {
  assert.equal(shouldScan({ event: "workflow_dispatch", enabled: "" }).run, true);
  assert.equal(shouldScan({ event: "push", enabled: "true" }).run, true);
  assert.equal(shouldScan({ event: "workflow_run", enabled: "", lastOkAt: null }).run, true);
  assert.equal(shouldScan({ event: "workflow_run", enabled: "", lastOkAt: "2026-09-02T03:45:00Z", now: T, minMinutes: 30 }).run, false);
  assert.equal(shouldScan({ event: "schedule", enabled: "", lastOkAt: "2026-09-02T03:29:00Z", now: T, minMinutes: 30 }).run, true);
  assert.equal(shouldScan({ event: "workflow_run", enabled: "", lastOkAt: "garbage", now: T }).run, true, "unreadable time never blocks");
  assert.equal(shouldScan({ event: "workflow_run", enabled: "", lastOkAt: "2026-09-02T03:45:00Z", now: T, minMinutes: "0" }).run, false, "0 falls back to the default 30");
});
