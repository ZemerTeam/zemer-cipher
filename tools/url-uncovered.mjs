// Add every live player whose OWN hash is missing from the table to the scan's `unknown` list.
//
// The harness scan counts a hash as covered when its md5-of-first-10000-bytes is a known alias.
// Devices never resolve a player that way: PlayerJsFetcher passes the player-URL hash as knownHash,
// so getHardcodedConfig looks up that hash only. An md5-only match therefore leaves every device
// without a config for the live player (zemer-cipher#188: f2999a12 and 1b3be681 served for a day,
// every cipher client dead). Routing such a hash into `unknown` sends it through the normal
// derive -> independent 206 verify -> alert -> apply -> player_dates -> deploy path.
//
//   node tools/url-uncovered.mjs <scan.json> <player_configs.json>
//
// Rewrites scan.json in place; stdout: the hashes it added, space-separated.
import { readFileSync, writeFileSync } from "node:fs";
import { coveredKeys } from "./apply-entry.mjs";

/** The distinct live hashes that are neither a key/alias in the table nor already unknown. Pure. */
export function urlUncovered(scan, players) {
  const covered = coveredKeys(players);
  const unknown = new Set((scan.unknown ?? []).map((u) => u.hash));
  return (scan.distinct ?? []).filter((d) => !covered.has(d.hash) && !unknown.has(d.hash));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [scanFile, configFile] = process.argv.slice(2);
  const scan = JSON.parse(readFileSync(scanFile, "utf8"));
  const added = urlUncovered(scan, JSON.parse(readFileSync(configFile, "utf8")).players);
  scan.unknown = [...(scan.unknown ?? []), ...added.map((d) => ({ hash: d.hash, count: d.count, md5: null, sts: null }))];
  writeFileSync(scanFile, JSON.stringify(scan, null, 2));
  process.stdout.write(added.map((d) => d.hash).join(" "));
}
