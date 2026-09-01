// Propose a player_configs.json entry for an unknown player hash.
//
// Runs the zemer-app harness validator (tests/validate-player-config.mjs — the same tool the
// manual rotation runbook uses, so there is no second copy of the derivation rules) as a CHILD
// PROCESS WITH A SCRUBBED ENVIRONMENT, then applies the stricter rules an unattended pipeline
// needs on top of the human one:
//
//   * AMBIGUITY REFUSAL. The harness validator stops at the first candidate pair that returns
//     206 and prints it. Multiple constant pairs CAN decipher correctly, and picking the wrong
//     one ships a config that works today and breaks on the next player skin. If more than one
//     pair reports "WORKS" we refuse to propose anything and let a human look.
//   * SHAPE VALIDATION. The parsed entry must satisfy the same regexes the app's
//     PlayerConfigParser enforces, before it is ever written anywhere.
//
// The child gets no inherited environment: the untrusted 2.9 MB of obfuscated YouTube base.js is
// evaluated in jsdom, which is explicitly NOT a security boundary, so it must not be able to read
// whatever the runner happens to be holding. Only the variables listed in CHILD_ENV_ALLOWLIST are
// forwarded, and each is either inert or a credential the validation genuinely needs.
//
//   node tools/propose-config.mjs <hash> --harness <dir> [--out entry.json]
//
// stdout: JSON { ok, hash, entry, reason, attempts, workingPairs }
// exit 0 when a single validated entry was produced, 1 otherwise (including refusals).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

// ADVISORY pre-filter only. These mirror PlayerConfigParser's shape rules so an obviously-malformed
// validator line is rejected before it travels further, but they are NOT the authority and are
// deliberately NOT pinned by the config-parity fixtures (those pin the Kotlin parser and
// tests/player-configs.mjs). The authoritative acceptance is done downstream by verify-entry (live
// 206) and apply-entry, which re-parses the exact bytes with the real parsePlayerConfigs. So if
// these regexes ever drift from the app's rules the worst case is an over-reject (a valid rotation
// punted to a human), never a bad deploy.
const HASH_RE = /^[a-f0-9]{8}$/;
const SIG_RE = /^[A-Za-z0-9$_]{1,8}\(\d+,\d+,INPUT\)$/;
const NCLASS_RE = /^[A-Za-z0-9$_]{1,8}$/;

// PATH/HOME so node can start and npm's resolution works; the YT_* trio is the credential the
// validator needs to reach a signatureCipher (absent = guest mode, which is the default).
// VALIDATION_VIDEO_ID is what the harness validator reads; VALIDATION_VIDEO_IDS is the operator's
// comma-list override — childEnv() derives the singular from the first of the plural (see below),
// so one repo var (VALIDATION_VIDEO_IDS) drives BOTH the derive step and verify-entry.
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "NODE_PATH",
  "YT_COOKIE",
  "YT_VISITOR_DATA",
  "YT_DATASYNC_ID",
  "COOKIE_FILE",
  "VALIDATION_VIDEO_ID",
];

const WORKS_MARKER = "✓ WORKS";
const RESULT_MARKER = "VALIDATOR_RESULT=";
const CHILD_TIMEOUT_MS = 180_000;
// The validator logs a line per candidate pair while evaluating 2.9 MB of base.js; 2 MiB leaves
// generous headroom above the real output (a few KB) without letting a runaway stream grow unbounded.
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * The env handed to the untrusted child: allowlisted keys only, never process.env wholesale.
 * The harness validator reads VALIDATION_VIDEO_ID (singular, one video); the operator-facing
 * override is VALIDATION_VIDEO_IDS (plural, comma list, also consumed by verify-entry). Translate
 * the first of the plural into the singular the validator understands, unless the singular is set
 * explicitly.
 */
export function childEnv(source = process.env) {
  const env = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (source[key] != null && source[key] !== "") env[key] = source[key];
  }
  if (!env.VALIDATION_VIDEO_ID && source.VALIDATION_VIDEO_IDS) {
    const first = source.VALIDATION_VIDEO_IDS.split(",").map((v) => v.trim()).filter(Boolean)[0];
    if (first) env.VALIDATION_VIDEO_ID = first;
  }
  return env;
}

/**
 * Decide what the validator's output means. Pure — this is the part worth unit-testing, and it
 * is where the unattended pipeline is stricter than the human runbook.
 */
export function interpretValidatorOutput(hash, stdout) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());

  // Preferred path: the validator's structured VALIDATOR_RESULT line — a stable machine contract,
  // NOT scraped human text. This is what makes the pipeline robust to log-format changes.
  const resultLine = lines.find((line) => line.startsWith(RESULT_MARKER));
  if (resultLine) {
    let r;
    try {
      r = JSON.parse(resultLine.slice(RESULT_MARKER.length));
    } catch (e) {
      return { ok: false, reason: `${RESULT_MARKER} is not valid JSON: ${e.message}` };
    }
    if (r.hash !== hash) {
      return { ok: false, reason: `${RESULT_MARKER} hash '${r.hash}' != requested '${hash}'` };
    }
    if (r.ambiguous) {
      // More than one candidate both deciphered AND ran a real n-transform: refuse rather than
      // guess which one the server truly accepts.
      return { ok: false, reason: `ambiguous: ${r.workingCount} candidate pairs validated`, workingPairs: [] };
    }
    if (!r.ok || !r.entry) {
      return { ok: false, reason: `no candidate pair returned 206 (workingCount=${r.workingCount ?? 0})` };
    }
    const shape = validateEntryShape(hash, r.entry);
    if (!shape.ok) return { ok: false, reason: shape.reason };
    return { ok: true, entry: r.entry };
  }

  // Fallback (an older validator without the structured line): scrape, but count ONLY candidates
  // that both 206'd AND ran a real n-transform. A correct-sig / wrong-n pair also returns 206 in
  // googlevideo's first-1-MiB free window and still prints "✓ WORKS", so counting bare WORKS lines
  // over-refuses a clean single-winner rotation as "ambiguous".
  const workingPairs = lines
    .filter((line) => line.includes(WORKS_MARKER) && /nProbe\.changed=true/.test(line));

  if (workingPairs.length === 0) {
    return { ok: false, reason: "no candidate pair returned 206", workingPairs };
  }
  if (workingPairs.length > 1) {
    return {
      ok: false,
      reason: `ambiguous: ${workingPairs.length} candidate pairs validated`,
      workingPairs,
    };
  }

  // The validator prints exactly one paste-ready entry line:
  //     "b0d2d49a": { "sig": "EP(3,4223,INPUT)", "nClass": "eg", "sts": 20676, "aliases": ["6fd8f6f9"] }
  const entryLine = lines.find((line) => new RegExp(`^"${hash}":\\s*\\{`).test(line));
  if (!entryLine) {
    return { ok: false, reason: "validator reported a winner but printed no entry line", workingPairs };
  }

  let parsed;
  try {
    parsed = JSON.parse(`{${entryLine}}`);
  } catch (e) {
    return { ok: false, reason: `entry line is not valid JSON: ${e.message}`, workingPairs };
  }

  const entry = parsed[hash];
  const shape = validateEntryShape(hash, entry);
  if (!shape.ok) return { ok: false, reason: shape.reason, workingPairs };

  return { ok: true, entry, workingPairs };
}

/** Enforce the app's own accept rules before the entry is allowed anywhere near the config file. */
export function validateEntryShape(hash, entry) {
  if (!HASH_RE.test(hash)) return { ok: false, reason: `bad player hash '${hash}'` };
  if (!entry || typeof entry !== "object") return { ok: false, reason: "entry is not an object" };
  if (!SIG_RE.test(entry.sig ?? "")) return { ok: false, reason: `bad sig '${entry.sig}'` };
  if (!NCLASS_RE.test(entry.nClass ?? "")) return { ok: false, reason: `bad nClass '${entry.nClass}'` };
  if (!Number.isInteger(entry.sts) || entry.sts <= 0) {
    return { ok: false, reason: `bad sts '${entry.sts}'` };
  }
  const aliases = entry.aliases ?? [];
  if (!Array.isArray(aliases)) return { ok: false, reason: "aliases is not an array" };
  for (const alias of aliases) {
    if (!HASH_RE.test(alias)) return { ok: false, reason: `bad alias '${alias}'` };
    if (alias === hash) return { ok: false, reason: "alias duplicates the primary hash" };
  }
  return { ok: true };
}

function runValidator(hash, harnessDir) {
  return new Promise((resolve, reject) => {
    // Absolute: the child's cwd is the harness root, so a relative script path would be resolved
    // against it a second time.
    const root = path.resolve(harnessDir);
    const script = path.join(root, "tests", "validate-player-config.mjs");
    const child = spawn(process.execPath, [script, hash], {
      cwd: root,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let overflowed = false;
    const collect = (chunk, into) => {
      if (into.length + chunk.length > MAX_OUTPUT_BYTES) {
        overflowed = true;
        child.kill("SIGKILL");
        return into;
      }
      return into + chunk;
    };
    child.stdout.on("data", (c) => (stdout = collect(String(c), stdout)));
    child.stderr.on("data", (c) => (stderr = collect(String(c), stderr)));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`validator timed out after ${CHILD_TIMEOUT_MS}ms`));
    }, CHILD_TIMEOUT_MS);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (overflowed) return reject(new Error("validator output exceeded the byte cap"));
      resolve({ code, stdout, stderr });
    });
  });
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const hash = process.argv[2];
  const harnessDir = arg("--harness", "harness");
  const outFile = arg("--out");
  if (!hash || !HASH_RE.test(hash)) {
    console.error("usage: node tools/propose-config.mjs <hash> --harness <dir> [--out entry.json]");
    process.exit(1);
  }

  let run;
  try {
    run = await runValidator(hash, harnessDir);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, hash, reason: e.message }, null, 2));
    process.exit(1);
  }

  // The validator's own exit code is not the verdict — it exits 0 even when nothing validated.
  // The verdict comes from interpreting what it printed.
  const verdict = interpretValidatorOutput(hash, run.stdout);
  const result = {
    ok: verdict.ok,
    hash,
    entry: verdict.entry ?? null,
    reason: verdict.reason ?? null,
    workingPairs: verdict.workingPairs ?? [],
    validatorExit: run.code,
  };

  process.stderr.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  console.log(JSON.stringify(result, null, 2));

  if (verdict.ok && outFile) {
    writeFileSync(outFile, JSON.stringify({ hash, entry: verdict.entry }, null, 2));
  }
  process.exit(verdict.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.log(JSON.stringify({ ok: false, reason: e.message }, null, 2));
    process.exit(1);
  });
}
