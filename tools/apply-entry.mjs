// Append a verified entry to player_configs.json — append-only, format-preserving, re-parsed.
//
// This is the ONLY writer. Devices fetch this exact file from cipher master and self-heal from it
// within minutes, so an unattended write has to be provably additive:
//
//   * APPEND-ONLY. Every pre-existing player key must survive byte-identically, `schemaVersion`
//     must not move, and exactly one key may appear. Anything else aborts without writing.
//   * NO COLLISIONS. The new hash and each of its aliases must not already exist as a primary key
//     or as any other entry's alias — a duplicate key or alias makes the app reject the WHOLE file
//     and keep its last-good table, i.e. it would silently freeze every device's config.
//   * RE-PARSED. The serialized text is fed back through the harness parser (the same rules the
//     app's PlayerConfigParser applies) before it is written, so we never commit a file the app
//     would refuse.
//
// Formatting is emitted by hand rather than via JSON.stringify: the file is one line per player,
// and reflowing 260 entries would bury a one-line change in an unreviewable diff.
//
//   node tools/apply-entry.mjs --config <path> --entry entry.json --harness <dir> [--dry-run]

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HASH_RE = /^[a-f0-9]{8}$/;

/** Every hash a device would accept from this table: primaries plus aliases. */
export function coveredKeys(players) {
  const keys = new Set();
  for (const [primary, entry] of Object.entries(players)) {
    keys.add(primary);
    for (const alias of entry.aliases ?? []) keys.add(alias);
  }
  return keys;
}

/** Reject anything that is not a clean addition. Pure — this is the safety gate worth testing. */
export function checkAppendOnly(before, after, newHash) {
  if (before.schemaVersion !== after.schemaVersion) {
    return { ok: false, reason: `schemaVersion changed ${before.schemaVersion} -> ${after.schemaVersion}` };
  }
  const beforeKeys = Object.keys(before.players);
  const afterKeys = Object.keys(after.players);
  const added = afterKeys.filter((k) => !beforeKeys.includes(k));
  const removed = beforeKeys.filter((k) => !afterKeys.includes(k));

  if (removed.length) return { ok: false, reason: `entries removed: ${removed.join(",")}` };
  if (added.length !== 1) return { ok: false, reason: `expected exactly 1 new entry, got ${added.length}` };
  if (added[0] !== newHash) return { ok: false, reason: `added '${added[0]}', expected '${newHash}'` };

  for (const key of beforeKeys) {
    const a = JSON.stringify(before.players[key]);
    const b = JSON.stringify(after.players[key]);
    if (a !== b) return { ok: false, reason: `existing entry '${key}' was modified` };
  }
  return { ok: true };
}

/**
 * Is this entry already covered by the table — as its primary hash OR any of its md5 aliases?
 * Used to classify a collision as a NO-OP (already deployed, incl. an earlier same-md5 skin in
 * the same batch) rather than a hard error. Pure.
 */
export function entryAlreadyCovered(players, hash, aliases = []) {
  const covered = coveredKeys(players);
  return covered.has(hash) || aliases.some((a) => covered.has(a));
}

/** Collision check against the whole accepted key space, not just primary keys. */
export function checkNoCollision(players, hash, aliases) {
  const covered = coveredKeys(players);
  if (covered.has(hash)) return { ok: false, reason: `hash '${hash}' is already covered` };
  for (const alias of aliases) {
    if (covered.has(alias)) return { ok: false, reason: `alias '${alias}' is already covered` };
  }
  if (new Set(aliases).size !== aliases.length) {
    return { ok: false, reason: "entry has duplicate aliases" };
  }
  return { ok: true };
}

/** One line per player, matching the committed file byte-for-byte in shape. */
export function serializeEntry(hash, entry) {
  const aliases = entry.aliases ?? [];
  const aliasPart = aliases.length ? `, "aliases": [${aliases.map((a) => `"${a}"`).join(", ")}]` : "";
  return `    "${hash}": { "sig": "${entry.sig}", "nClass": "${entry.nClass}", "sts": ${entry.sts}${aliasPart} }`;
}

/**
 * Insert the new line after the current last player line, adding the comma the previous last line
 * now needs. Text-level so untouched lines stay untouched in the diff.
 */
export function insertEntryLine(text, hash, entry) {
  const lines = text.split("\n");
  let lastPlayerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s+"[a-f0-9]{8}":\s*\{/.test(lines[i])) lastPlayerIdx = i;
  }
  if (lastPlayerIdx < 0) throw new Error("no existing player lines found — refusing to write");
  if (!/,\s*$/.test(lines[lastPlayerIdx])) lines[lastPlayerIdx] += ",";
  lines.splice(lastPlayerIdx + 1, 0, serializeEntry(hash, entry));
  return lines.join("\n");
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const configPath = arg("--config", "library/src/main/assets/player_configs.json");
  const entryFile = arg("--entry");
  const harnessDir = arg("--harness", "harness");
  const dryRun = process.argv.includes("--dry-run");
  if (!entryFile) {
    console.error("usage: node tools/apply-entry.mjs --config <path> --entry entry.json --harness <dir>");
    process.exit(1);
  }

  const { hash, entry } = JSON.parse(readFileSync(entryFile, "utf8"));
  if (!HASH_RE.test(hash)) throw new Error(`bad hash '${hash}'`);

  const originalText = readFileSync(configPath, "utf8");
  const before = JSON.parse(originalText);

  const collision = checkNoCollision(before.players, hash, entry.aliases ?? []);
  if (!collision.ok) {
    // Already covered is a NO-OP, not a failure: master moves out-of-band when a rotation is
    // deployed by hand, and the pipeline must never treat that as an error to retry forever.
    // "Covered" means the whole accepted key space — the primary hash OR any of the entry's md5
    // aliases already present. Two byte-identical skins in ONE batch share an md5 alias: once the
    // first is applied, the second is genuinely redundant (a device computes the same md5 and
    // resolves it), so it must exit 0 (noop) — NOT exit 1, which under `set -e` would abort the
    // whole deploy apply loop and discard the first, already-applied entry.
    const alreadyCovered = entryAlreadyCovered(before.players, hash, entry.aliases ?? []);
    console.log(JSON.stringify({ ok: false, noop: alreadyCovered, reason: collision.reason }, null, 2));
    process.exit(alreadyCovered ? 0 : 1);
  }

  const nextText = insertEntryLine(originalText, hash, entry);

  let after;
  try {
    after = JSON.parse(nextText);
  } catch (e) {
    throw new Error(`result is not valid JSON: ${e.message}`);
  }

  const appendOnly = checkAppendOnly(before, after, hash);
  if (!appendOnly.ok) throw new Error(appendOnly.reason);

  // Final gate: the app's own accept rules, applied to the exact bytes we are about to commit.
  const { parsePlayerConfigs } = await import(
    pathToFileURL(path.resolve(harnessDir, "tests", "player-configs.mjs")).href
  );
  const parsed = parsePlayerConfigs(nextText, configPath);
  if (!parsed[hash]) throw new Error("parser did not accept the new entry");
  const parsedCount = Object.keys(parsed).length;
  const beforeCount = Object.keys(before.players).length;
  if (parsedCount !== beforeCount + 1) {
    throw new Error(`parser accepted ${parsedCount} entries, expected ${beforeCount + 1}`);
  }

  if (!dryRun) writeFileSync(configPath, nextText);
  console.log(
    JSON.stringify(
      { ok: true, noop: false, hash, entry, entries: parsedCount, dryRun, line: serializeEntry(hash, entry).trim() },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.log(JSON.stringify({ ok: false, reason: e.message }, null, 2));
    process.exit(1);
  });
}
