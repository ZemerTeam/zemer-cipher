// Add player hashes that real devices reported missing to the scan's `unknown` list.
//
// Devices can be served a player URL hash the scan never sees: the same build is published under
// another hash on Google front ends our vantage points don't reach (e784b7f5, 2026-11-02: a byte-twin
// of 4a1e575f that only devices got, and every one of them 403'd). The server finds such hashes in
// signed crash reports ("No hardcoded config for hash: <h>") and dispatches this workflow with them
// as the `hashes` input. They are untrusted data: only 8-hex hashes, at most MAX_DEVICE_HASHES, and
// only ones that are not already a URL key go on. From here they take the normal derive -> two
// independent 206 checks -> alert -> apply -> deploy path, so a bogus hash just fails validation.
//
//   DEVICE_HASHES="<h1> <h2>" node tools/device-hashes.mjs <scan.json> <player_configs.json>
//
// Rewrites scan.json in place; stdout: the hashes it added, space-separated.
import { readFileSync, writeFileSync } from "node:fs";

export const MAX_DEVICE_HASHES = 5;
const HASH_RE = /^[0-9a-f]{8}$/;

/**
 * The device-reported hashes to validate: well-formed, deduped, capped, and neither a URL key in the
 * table (devices look a player up by its URL hash only) nor already unknown. Pure.
 */
export function deviceHashes(raw, scan, players) {
  const valid = [...new Set(String(raw ?? "").split(/\s+/).filter((h) => HASH_RE.test(h)))].slice(0, MAX_DEVICE_HASHES);
  const unknown = new Set((scan.unknown ?? []).map((u) => u.hash));
  return valid.filter((h) => !Object.hasOwn(players, h) && !unknown.has(h));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [scanFile, configFile] = process.argv.slice(2);
  const scan = JSON.parse(readFileSync(scanFile, "utf8"));
  const added = deviceHashes(process.env.DEVICE_HASHES, scan, JSON.parse(readFileSync(configFile, "utf8")).players);
  scan.unknown = [...(scan.unknown ?? []), ...added.map((hash) => ({ hash, count: 0, md5: null, sts: null, source: "device" }))];
  writeFileSync(scanFile, JSON.stringify(scan, null, 2));
  process.stdout.write(added.join(" "));
}
