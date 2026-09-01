// Bump one entry's client IDENTITY to yt-dlp master's values — the auto-bump writer of the client
// monitor. A bump only ever reaches this file after the candidate table (the same edit written to
// --out) drained a WHOLE song on every validation video, so the write itself has to be provably
// minimal, like apply-bench:
//
//   * IDENTITY FIELDS ONLY. clientVersion, userAgent, osName, osVersion, deviceMake, deviceModel,
//     androidSdkVersion — the fields the table mirrors from yt-dlp. key / clientName / clientId /
//     protocol / family / flags / sabr / mirrors can never change here.
//   * IN-PLACE LINES. An existing field's line gets its value replaced; a field the entry lacks is
//     inserted after its clientVersion line. Every other line of the file survives byte-identically.
//   * RE-PARSED. The result is fed through the harness loader: same keys in the same order, same
//     skips, every OTHER entry deep-equal, and the target entry equal to the old one except for
//     exactly the requested fields at exactly the requested values.
//
//   node tools/clients/apply-bump.mjs --config <path> --key <KEY> --fields '{"clientVersion":"..."}' \
//        --harness <dir> [--out <candidate path>] [--dry-run]
//   stdout: JSON { ok, key, noop, changes, reason }

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const IDENTITY_FIELDS = ["clientVersion", "userAgent", "osName", "osVersion", "deviceMake", "deviceModel", "androidSdkVersion"];

const VALID = {
  clientVersion: (v) => /^[A-Za-z0-9._-]{1,32}$/.test(v),
  osVersion: (v) => /^[A-Za-z0-9._-]{1,32}$/.test(v),
  androidSdkVersion: (v) => /^[A-Za-z0-9._-]{1,32}$/.test(v),
  userAgent: (v) => v.length > 0 && v.length <= 300 && /^[\x20-\x7E]+$/.test(v),
  osName: (v) => v.length > 0 && v.length <= 64 && /^[\x20-\x7E]+$/.test(v),
  deviceMake: (v) => v.length > 0 && v.length <= 64 && /^[\x20-\x7E]+$/.test(v),
  deviceModel: (v) => v.length > 0 && v.length <= 64 && /^[\x20-\x7E]+$/.test(v),
};

function entryBounds(lines, key) {
  const keyRe = new RegExp(`^(\\s*)"key":\\s*"${key}",?\\s*$`);
  const hits = lines.map((l, i) => (keyRe.test(l) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) throw new Error(`expected exactly one "key": "${key}" line, found ${hits.length}`);
  const at = hits[0];
  let open = at; while (open > 0 && !/^\s*\{\s*$/.test(lines[open])) open--;
  let close = at; while (close < lines.length - 1 && !/^\s*\},?\s*$/.test(lines[close])) close++;
  return { at, open, close, indent: lines[at].match(keyRe)[1] };
}

/**
 * Pure text edit. Returns { text, changed, applied: {field: value} } — `changed` false when every
 * field already holds its target value. Throws on an unknown field, an invalid value (the same
 * shapes the parser enforces, so a candidate can never be a file the app would skip), or an
 * ambiguous key.
 */
export function bumpEntryText(text, key, fields) {
  const lines = text.split("\n");
  let { open, close, indent } = entryBounds(lines, key);
  const applied = {};
  // Missing fields are inserted in request order, each after the previous insert (the first
  // after the clientVersion line), so the entry reads clientVersion, then the new fields.
  let insertAt = -1;
  for (const [field, value] of Object.entries(fields)) {
    if (!IDENTITY_FIELDS.includes(field)) throw new Error(`${field} is not an identity field`);
    if (typeof value !== "string" || !VALID[field](value)) throw new Error(`invalid ${field}: ${JSON.stringify(value)}`);
    const re = new RegExp(`^(\\s*)"${field}":\\s*(".*")(,?)\\s*$`);
    let idx = -1;
    for (let i = open; i <= close; i++) if (re.test(lines[i])) { idx = i; break; }
    if (idx >= 0) {
      const m = lines[idx].match(re);
      if (JSON.parse(m[2]) === value) continue;
      lines[idx] = `${m[1]}"${field}": ${JSON.stringify(value)}${m[3]}`;
    } else {
      if (insertAt < 0) {
        for (let i = open; i <= close; i++) if (/^\s*"clientVersion":/.test(lines[i])) { insertAt = i; break; }
        if (insertAt < 0) throw new Error(`entry ${key} has no clientVersion line to anchor on`);
      }
      insertAt += 1;
      lines.splice(insertAt, 0, `${indent}"${field}": ${JSON.stringify(value)},`);
      close += 1;
    }
    applied[field] = value;
  }
  return { text: lines.join("\n"), changed: Object.keys(applied).length > 0, applied };
}

const strip = (c) => { const o = { ...c }; for (const f of IDENTITY_FIELDS) delete o[f]; return o; };
const same = (a, b) => JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());

/** The bump invariants over a (before, after) pair; `parse` is the harness loader. Throws on any violation. */
export function verifyBump(before, after, key, fields, parse) {
  const was = parse(before), now = parse(after);
  if (was.skipped.join(",") !== now.skipped.join(",")) throw new Error("the set of skipped entries changed");
  const wasKeys = was.clients.map((c) => c.key), nowKeys = now.clients.map((c) => c.key);
  if (wasKeys.join(",") !== nowKeys.join(",")) throw new Error(`live chain changed: ${wasKeys.join(",")} -> ${nowKeys.join(",")}`);
  if (!wasKeys.includes(key)) throw new Error(`${key} is not a live entry`);
  const changes = {};
  for (let i = 0; i < wasKeys.length; i++) {
    const a = was.clients[i], b = now.clients[i];
    if (a.key !== key) {
      if (!same(a, b)) throw new Error(`entry ${a.key} changed but was not the target`);
      continue;
    }
    if (!same(strip(a), strip(b))) throw new Error(`${key}: a non-identity field changed`);
    for (const f of IDENTITY_FIELDS) {
      if (f in fields) {
        if (b[f] !== fields[f]) throw new Error(`${key}.${f} is ${JSON.stringify(b[f])}, expected ${JSON.stringify(fields[f])}`);
        if (a[f] !== b[f]) changes[f] = { from: a[f] ?? null, to: b[f] };
      } else if ((a[f] ?? null) !== (b[f] ?? null)) {
        throw new Error(`${key}.${f} changed but was not requested`);
      }
    }
  }
  return { changes };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const config = arg("--config"), key = arg("--key"), harness = arg("--harness"), out = arg("--out");
  const dryRun = process.argv.includes("--dry-run");
  const emit = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(o.ok ? 0 : 1); };
  let fields;
  try { fields = JSON.parse(arg("--fields") || ""); } catch { emit({ ok: false, key, reason: "--fields must be a JSON object" }); }
  if (!config || !key || !harness || !fields || typeof fields !== "object") {
    emit({ ok: false, key, reason: "usage: --config <path> --key <KEY> --fields <json> --harness <dir> [--out <path>] [--dry-run]" });
  }
  const { parseStreamClients } = await import(pathToFileURL(path.resolve(harness, "tests/stream-clients.mjs")).href);
  const before = readFileSync(config, "utf8");
  try {
    const edit = bumpEntryText(before, key, fields);
    if (!edit.changed) emit({ ok: true, key, noop: true, reason: "entry already carries these values" });
    const check = verifyBump(before, edit.text, key, fields, parseStreamClients);
    if (out) writeFileSync(out, edit.text);
    else if (!dryRun) writeFileSync(config, edit.text);
    emit({ ok: true, key, noop: false, dryRun, out: out || null, ...check });
  } catch (e) {
    emit({ ok: false, key, reason: e.message });
  }
}
