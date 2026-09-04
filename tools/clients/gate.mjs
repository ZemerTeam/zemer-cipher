// The rate gate as a pure function (tested): should THIS run scan?
//   event      github.event_name ("workflow_dispatch", "push", "schedule", "workflow_run", ...)
//   enabled    CLIENT_MONITOR_ENABLED ("false" disables everything)
//   lastOkAt   ISO time of the last successful scan (or null)
//   now        ISO time now
//   minMinutes MIN_SCAN_INTERVAL_MINUTES
// Manual dispatches and feature-branch pushes always scan (unless disabled); chained/scheduled
// runs scan only when the last successful scan is old enough.
//
//   node tools/clients/gate.mjs <event> <enabled> <lastOkAt|""> <minMinutes>   -> prints "true"/"false" + reason

export function shouldScan({ event, enabled, lastOkAt, now = new Date().toISOString(), minMinutes = 30 }) {
  if (String(enabled) === "false") return { run: false, reason: "CLIENT_MONITOR_ENABLED=false - monitor disabled" };
  if (event === "workflow_dispatch" || event === "push") return { run: true, reason: `${event}: scanning` };
  if (!lastOkAt) return { run: true, reason: "no previous successful scan: scanning" };
  const age = Math.floor((new Date(now) - new Date(lastOkAt)) / 60000);
  if (!Number.isFinite(age)) return { run: true, reason: "unreadable last-scan time: scanning" };
  const min = Number(minMinutes) || 30;
  return age >= min ? { run: true, reason: `last successful scan ${age} min ago (>= ${min}): scanning` } : { run: false, reason: `last successful scan ${age} min ago (< ${min}): skipping this chained run` };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [event, enabled, lastOkAt, minMinutes] = process.argv.slice(2);
  const r = shouldScan({ event, enabled, lastOkAt: lastOkAt || null, minMinutes });
  console.log(`${r.run} ${r.reason}`);
}
