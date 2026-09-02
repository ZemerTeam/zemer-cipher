// Bench (or un-bench) one stream-client entry: the ONLY writer the client monitor has. Devices
// fetch this exact file from master and pick a change up within hours (or at once after a total
// resolution failure), so an unattended write must be provably minimal:
//
//   * ONE LINE. A bench inserts exactly one `"enabled": false,` line after the entry's `"key"`
//     line — the schema's kill switch — and an un-bench removes exactly that line; nothing else
//     may change: every other line of the file must survive byte-identically.
//   * NEVER THE MAIN. Entry 0 is refused here too (belt and braces over decide.mjs): a benched main
//     row makes the whole file invalid and every device keeps its last-good table, i.e. nothing
//     would change but the alert would say it did.
//   * RE-PARSED. The result is fed through the harness loader (the app's own validation rules):
//     it must parse, the benched key must be the ONLY new skip, and the live chain must still be
//     the old chain minus that key with at least `minLiveFallbacks` live fallbacks.
//
//   node tools/clients/apply-bench.mjs --config <path> --key <KEY> --harness <dir> [--unbench] [--dry-run]
//   stdout: JSON { ok, key, noop, reason }

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The kill-switch line in any whitespace/comma layout a human might write. */
const ENABLED_FALSE_RE = /^\s*"enabled"\s*:\s*false\s*,?\s*$/;

/**
 * The entry object around the unique `"key": "<key>"` line: from its `{` line to the MATCHING
 * `}` line by brace depth (a nested `sabr: { ... }` block must not end the entry early). Assumes
 * the file's pretty-printed one-field-per-line layout; the harness loader re-parse is the gate.
 */
function entryBounds(lines, key) {
  const keyRe = new RegExp(`^(\\s*)"key"\\s*:\\s*"${key}"\\s*,?\\s*$`);
  const hits = lines.map((l, i) => (keyRe.test(l) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) throw new Error(`expected exactly one "key": "${key}" line, found ${hits.length}`);
  const at = hits[0];
  const indent = lines[at].match(keyRe)[1];
  const braces = (l) => {
    // Count braces outside string literals.
    let depth = 0, inStr = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (inStr) { if (ch === "\\") i++; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === "{") depth++; else if (ch === "}") depth--;
    }
    return depth;
  };
  let open = at, depth = 0;
  // Walking UP, the entry's own `{` is the first line where the running brace count turns
  // positive (a nested block's `}` below the key is cancelled by its own `{` on the way up).
  while (open >= 0) { depth += braces(lines[open]); if (depth > 0) break; open--; }
  if (open < 0) throw new Error(`no opening brace above the ${key} key line`);
  let close = at; depth = 0;
  for (let i = open; i < lines.length; i++) { depth += braces(lines[i]); if (i > open && depth <= 0) { close = i; break; } }
  if (close <= at) throw new Error(`no closing brace below the ${key} key line`);
  return { at, open, close, indent };
}

/**
 * Pure text edit: insert `"enabled": false,` after the `"key": "<key>"` line of that entry,
 * matching its indentation. Returns { text, changed:false, reason } when the entry is already
 * benched (any `"enabled"` line inside its object) and throws when the key line is not unique.
 */
export function benchEntryText(text, key) {
  const lines = text.split("\n");
  const { at, open, close, indent } = entryBounds(lines, key);
  if (lines.slice(open, close + 1).some((l) => /^\s*"enabled"\s*:/.test(l))) {
    return { text, changed: false, reason: "entry already carries an enabled flag" };
  }
  lines.splice(at + 1, 0, `${indent}"enabled": false,`);
  return { text: lines.join("\n"), changed: true };
}

/**
 * Pure text edit: remove the entry's kill-switch line in whatever layout it was written
 * (`"enabled": false,` / `"enabled":false` / as the LAST field without a trailing comma — in
 * which case the previous field's trailing comma goes too, so the object stays valid JSON).
 * No-op when the entry has none.
 */
export function unbenchEntryText(text, key) {
  const lines = text.split("\n");
  const { open, close } = entryBounds(lines, key);
  const rel = lines.slice(open, close + 1).findIndex((l) => ENABLED_FALSE_RE.test(l));
  if (rel < 0) return { text, changed: false, reason: "entry is not benched" };
  const flag = open + rel;
  const wasLastField = !/,\s*$/.test(lines[flag]);
  lines.splice(flag, 1);
  if (wasLastField) {
    // The field before it is now the last one: drop its trailing comma.
    const prev = flag - 1;
    if (prev > open && /,\s*$/.test(lines[prev])) lines[prev] = lines[prev].replace(/,\s*$/, "");
  }
  return { text: lines.join("\n"), changed: true };
}

/**
 * Un-bench invariants: exactly one removed line (the kill switch), the key leaves `skipped` and
 * joins the live chain with every other live key in its old order, main unchanged.
 */
export function verifyUnbench(before, after, key, parse) {
  const a = before.split("\n"), b = after.split("\n");
  if (b.length !== a.length - 1) throw new Error(`expected exactly one removed line, got ${a.length - b.length}`);
  let i = 0; while (i < b.length && a[i] === b[i]) i++;
  // Either the kill-switch line itself was removed here, or (last-field layout) the previous
  // line lost its trailing comma and the kill switch is the line after it.
  let removed = i;
  if (!ENABLED_FALSE_RE.test(a[i])) {
    if (a[i].replace(/,\s*$/, "") === b[i] && ENABLED_FALSE_RE.test(a[i + 1] || "")) { removed = i + 1; i += 1; }
    else throw new Error(`the removed line is not the kill switch: ${JSON.stringify(a[i])}`);
  }
  for (let j = i; j < b.length; j++) if (a[j + 1] !== b[j]) throw new Error(`line ${j + 1} changed besides the removal`);
  void removed;
  const was = parse(before), now = parse(after);
  const wasKeys = was.clients.map((c) => c.key), nowKeys = now.clients.map((c) => c.key);
  if (!was.skipped.includes(key)) throw new Error(`${key} is not a benched entry`);
  if (!nowKeys.includes(key)) throw new Error(`${key} did not come back as a live entry`);
  if (nowKeys[0] !== wasKeys[0]) throw new Error("the main client changed");
  if (nowKeys.filter((k) => k !== key).join(",") !== wasKeys.join(",")) throw new Error(`live chain after un-bench is ${nowKeys.join(",")}, expected ${wasKeys.join(",")} plus ${key}`);
  if (now.skipped.length !== was.skipped.length - 1 || now.skipped.includes(key)) throw new Error(`skips after un-bench are ${JSON.stringify(now.skipped)}`);
  return { liveBefore: wasKeys, liveAfter: nowKeys };
}

/**
 * The bench invariants over a (before, after) pair. `parse` is the harness loader's parseStreamClients
 * (or a test stub returning the same { clients, skipped } shape). Throws on any violation.
 */
export function verifyBench(before, after, key, parse, { minLiveFallbacks = 2 } = {}) {
  const a = before.split("\n"), b = after.split("\n");
  if (b.length !== a.length + 1) throw new Error(`expected exactly one inserted line, got ${b.length - a.length}`);
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  if (!/^\s*"enabled": false,$/.test(b[i])) throw new Error(`the inserted line is not the kill switch: ${JSON.stringify(b[i])}`);
  for (let j = i; j < a.length; j++) if (a[j] !== b[j + 1]) throw new Error(`line ${j + 1} changed besides the insert`);

  const was = parse(before), now = parse(after);
  const wasKeys = was.clients.map((c) => c.key), nowKeys = now.clients.map((c) => c.key);
  if (wasKeys[0] === key) throw new Error("refusing to bench the main client (entry 0)");
  if (!wasKeys.includes(key)) throw new Error(`${key} is not a live entry of the table`);
  if (nowKeys[0] !== wasKeys[0]) throw new Error("the main client changed");
  const expected = wasKeys.filter((k) => k !== key);
  if (nowKeys.join(",") !== expected.join(",")) throw new Error(`live chain after bench is ${nowKeys.join(",")}, expected ${expected.join(",")}`);
  const newSkips = now.skipped.filter((k) => !was.skipped.includes(k));
  if (newSkips.join(",") !== key) throw new Error(`new skips are ${JSON.stringify(newSkips)}, expected only ${key}`);
  if (nowKeys.length - 1 < minLiveFallbacks) throw new Error(`only ${nowKeys.length - 1} live fallback(s) would remain, minimum ${minLiveFallbacks}`);
  return { liveBefore: wasKeys, liveAfter: nowKeys };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const config = arg("--config"), key = arg("--key"), harness = arg("--harness");
  const dryRun = process.argv.includes("--dry-run");
  const unbench = process.argv.includes("--unbench");
  // The same floor the plan used (MIN_LIVE_FALLBACKS), so plan and writer can never disagree.
  const minLiveFallbacks = Number(arg("--min-live-fallbacks") || process.env.MIN_LIVE_FALLBACKS || 2);
  const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(o.ok ? 0 : 1); };
  if (!config || !key || !harness) out({ ok: false, key, reason: "usage: --config <path> --key <KEY> --harness <dir> [--dry-run]" });
  const { parseStreamClients } = await import(pathToFileURL(path.resolve(harness, "tests/stream-clients.mjs")).href);
  const before = readFileSync(config, "utf8");
  try {
    const edit = unbench ? unbenchEntryText(before, key) : benchEntryText(before, key);
    if (!edit.changed) out({ ok: true, key, noop: true, reason: edit.reason });
    const check = unbench
      ? verifyUnbench(before, edit.text, key, parseStreamClients)
      : verifyBench(before, edit.text, key, parseStreamClients, { minLiveFallbacks });
    if (!dryRun) writeFileSync(config, edit.text);
    out({ ok: true, key, noop: false, dryRun, unbench, ...check });
  } catch (e) {
    out({ ok: false, key, reason: e.message });
  }
}
