// Independently verify a proposed player_configs.json entry against the live CDN.
//
// This is deliberately a SECOND implementation of the check, written here in the cipher repo,
// separate from the zemer-app harness validator that proposed the entry. Nothing reaches master
// unless two independently-written code paths both get HTTP 206 out of it. It is also stricter
// than the proposer in three ways that matter when no human is watching:
//
//   * MULTI-SIGNATURE. The proposer validates ONE signature. A single sample can pass by luck
//     (e.g. a format whose `n` happens to round-trip). We require >= MIN_SIGNATURES *distinct*
//     `s` values to decipher and fetch, drawn from the ciphered audio formats of the response —
//     the same fluke guard faraday gets from two videos, without needing a second video to be
//     reachable (most ids are bot-gated from datacenter IPs).
//   * REAL BYTES. 206 alone is not proof. We require content-type audio/*, a well-formed
//     content-range, a final URL still on googlevideo /videoplayback (no redirect off-CDN), and
//     we actually drain MIN_STREAM_BYTES off the socket.
//   * SELF-CONSISTENCY. The entry's `sts` must equal the signatureTimestamp base.js declares,
//     and its md5 alias must equal the md5 of the first 10000 bytes — the identity devices key on.
//
// The n-transform template is imported from the harness rather than re-typed: it is pinned
// byte-for-byte against the Kotlin PlayerConfigParser by shared parity fixtures, and a third
// hand-written copy is exactly how those drift apart.
//
//   node tools/verify-entry.mjs --entry entry.json --harness <dir> [--videos a,b]
//
// stdout: JSON verdict. exit 0 only on a full pass.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// jsdom is imported lazily inside buildCipher so the pure predicates below stay importable
// (and unit-testable) without the dependency installed.

const ORIGIN = "https://music.youtube.com";
const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";
const WEB_REMIX = { clientName: "WEB_REMIX", clientVersion: "1.20260213.01.00", clientId: "67" };

const MIN_SIGNATURES = 2;
const MIN_STREAM_BYTES = 1024;
const RANGE = "bytes=0-262143";
const FETCH_TIMEOUT_MS = 20_000;
const N_PROBE_INPUT = "KdrqFlzJXl9EcCwlmEy";
const VALID_N_RESULT = /^[a-zA-Z0-9_-]+$/;

const md5hash4 = (s) =>
  crypto.createHash("md5").update(Buffer.from(s.slice(0, 10000), "utf8")).digest("hex").slice(0, 8);

const decodeVisitor = (v) => {
  try {
    return v && /%[0-9A-Fa-f]{2}/.test(v) ? decodeURIComponent(v) : v;
  } catch {
    return v;
  }
};

function sapisidHash(cookie) {
  const m = cookie.match(/(?:^|; )SAPISID=([^;]+)/);
  if (!m) return null;
  const ts = Math.floor(Date.now() / 1000);
  return `SAPISIDHASH ${ts}_${crypto
    .createHash("sha1")
    .update(`${ts} ${m[1]} ${ORIGIN}`)
    .digest("hex")}`;
}

async function withTimeout(fn, ms = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPlayerJs(hash) {
  const url = `https://www.youtube.com/s/player/${hash}/player_ias.vflset/en_GB/base.js`;
  const r = await withTimeout((signal) => fetch(url, { headers: { "User-Agent": WEB_UA }, signal }));
  if (!r.ok) throw new Error(`base.js HTTP ${r.status}`);
  return r.text();
}

/** Ciphered audio formats for one video, deduped by their `s` value. */
async function signatureCiphersFor(sts, videoId, cred) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": WEB_UA,
    "X-Goog-Api-Format-Version": "1",
    "X-YouTube-Client-Name": WEB_REMIX.clientId,
    "X-YouTube-Client-Version": WEB_REMIX.clientVersion,
    "X-Origin": ORIGIN,
    Referer: `${ORIGIN}/`,
  };
  if (cred.visitorData) headers["X-Goog-Visitor-Id"] = cred.visitorData;
  if (cred.cookie) {
    headers.cookie = cred.cookie;
    const auth = sapisidHash(cred.cookie);
    if (auth) headers.Authorization = auth;
  }
  const client = { clientName: WEB_REMIX.clientName, clientVersion: WEB_REMIX.clientVersion, gl: "US", hl: "en" };
  if (cred.visitorData) client.visitorData = cred.visitorData;

  const r = await withTimeout((signal) =>
    fetch(`${ORIGIN}/youtubei/v1/player?prettyPrint=false`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        context: { client },
        videoId,
        playbackContext: { contentPlaybackContext: { signatureTimestamp: sts } },
      }),
    }),
  );
  const json = JSON.parse(await r.text());
  const playability = json?.playabilityStatus?.status ?? null;
  const seen = new Map();
  for (const f of json?.streamingData?.adaptiveFormats ?? []) {
    if (!f.signatureCipher || !(f.mimeType || "").startsWith("audio/")) continue;
    const s = new URLSearchParams(f.signatureCipher).get("s");
    if (s && !seen.has(s)) seen.set(s, f.signatureCipher);
  }
  return { videoId, playability, ciphers: [...seen.values()] };
}

/** Evaluate base.js in jsdom with the entry's sig expression + n class. */
async function buildCipher(playerJs, sigExpr, nClass, nTrick) {
  const { JSDOM } = await import("jsdom");
  const nExpr = nTrick(nClass);
  const sigStmt = `window._cipherSigFunc = function(sig){ try { return ${sigExpr.replace(
    "INPUT",
    "sig",
  )}; } catch(e){ return null; } };`;
  const nStmt = `window._nTransformFunc = function(n){ try { return ${nExpr.replace(
    "INPUT",
    "n",
  )}; } catch(e){ return n; } };`;
  const exportCode = `; ${sigStmt} ${nStmt} `;
  let modified = playerJs.replace("})(_yt_player);", `${exportCode}})(_yt_player);`);
  if (modified === playerJs) modified = `${playerJs}\n${exportCode}`;

  const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
    url: "https://www.youtube.com/",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const win = dom.window;
  win._yt_player = {};
  if (!win.TextEncoder) win.TextEncoder = TextEncoder;
  if (!win.TextDecoder) win.TextDecoder = TextDecoder;
  let initError = null;
  try {
    win.eval(modified);
  } catch (e) {
    initError = e.message;
  }
  const sigFn = win._cipherSigFunc;
  const nFn = win._nTransformFunc;

  let nProbe = { changed: false, valid: false };
  try {
    const out = nFn(N_PROBE_INPUT);
    nProbe = {
      changed: !!out && out !== N_PROBE_INPUT,
      valid: !!out && out !== N_PROBE_INPUT && VALID_N_RESULT.test(String(out)),
    };
  } catch (e) {
    nProbe = { changed: false, valid: false, error: e.message };
  }

  return {
    initError,
    nProbe,
    deobfuscate(signatureCipher) {
      const p = {};
      for (const pair of signatureCipher.split("&")) {
        const i = pair.indexOf("=");
        if (i > 0) p[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
      }
      if (p.s == null || p.url == null) throw new Error("signatureCipher missing s/url");
      const sig = sigFn(p.s);
      if (sig == null) throw new Error("sig function returned null");
      let out = `${p.url}${p.url.includes("?") ? "&" : "?"}${p.sp || "signature"}=${encodeURIComponent(
        String(sig),
      )}`;
      const m = out.match(/[?&]n=([^&]+)/);
      if (m) {
        const t = nFn(decodeURIComponent(m[1]));
        out = out.replace(/([?&])n=[^&]+/, `$1n=${encodeURIComponent(t == null ? m[1] : String(t))}`);
      }
      return out;
    },
    close: () => win.close(),
  };
}

/** A 206 that is actually a playable audio range, not just a status code. */
export function cdnResponseIsValid({ status, contentType, contentRange, finalUrl, bytesRead }) {
  if (status !== 206) return false;
  if (!(contentType || "").toLowerCase().startsWith("audio/")) return false;
  if (!contentRange || !/^bytes 0-\d+\/(?:\d+|\*)$/i.test(contentRange)) return false;
  if (!isGoogleVideoPlaybackUrl(finalUrl)) return false;
  return bytesRead >= MIN_STREAM_BYTES;
}

export function isGoogleVideoPlaybackUrl(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" && u.hostname.endsWith(".googlevideo.com") && u.pathname === "/videoplayback"
    );
  } catch {
    return false;
  }
}

async function probeCdn(url) {
  if (!isGoogleVideoPlaybackUrl(url)) {
    return { status: "ERR:not-a-googlevideo-url", valid: false, bytesRead: 0 };
  }
  try {
    const r = await withTimeout((signal) =>
      fetch(url, { headers: { "User-Agent": WEB_UA, Range: RANGE, Connection: "close" }, signal }),
    );
    const contentType = r.headers.get("content-type");
    const contentRange = r.headers.get("content-range");
    let bytesRead = 0;
    if (r.body) {
      const reader = r.body.getReader();
      while (bytesRead < MIN_STREAM_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value?.byteLength ?? 0;
      }
      await reader.cancel();
    }
    const info = { status: r.status, contentType, contentRange, finalUrl: r.url, bytesRead };
    return { ...info, valid: cdnResponseIsValid(info) };
  } catch (e) {
    return { status: `ERR:${e.message.slice(0, 40)}`, valid: false, bytesRead: 0 };
  }
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const entryFile = arg("--entry");
  const harnessDir = arg("--harness", "harness");
  // We need MIN_SIGNATURES (>=2) DISTINCT signatures; the loop walks this list until it has enough.
  // Default to MORE THAN ONE video so a response that happens to carry <2 ciphered audio formats
  // (only itag 140 ciphered, the rest plain-url/SABR) doesn't reject an otherwise-valid entry —
  // it falls through to the next id. dQw4w9WgXcQ leads because from a datacenter IP almost every
  // other id is bot-gated in guest mode (measured 1 of 10), and it reliably returns 4 ciphered
  // audio formats; the extra ids are the fallback for the rare short response. Override with
  // --videos or the VALIDATION_VIDEO_IDS repo var (with a cookie, any id works).
  const videos = (arg("--videos", process.env.VALIDATION_VIDEO_IDS || "dQw4w9WgXcQ,84mNcwGCIUE,kJQP7kiw5Fk") || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (!entryFile) {
    console.error("usage: node tools/verify-entry.mjs --entry entry.json --harness <dir> [--videos a,b]");
    process.exit(1);
  }

  const { hash, entry } = JSON.parse(readFileSync(entryFile, "utf8"));
  // One JS copy of the n-IIFE template, shared with the harness and pinned to the Kotlin parser.
  const { nTrick } = await import(
    pathToFileURL(path.resolve(harnessDir, "tests", "player-configs.mjs")).href
  );

  const cred = {
    cookie: process.env.YT_COOKIE || "",
    visitorData: decodeVisitor(process.env.YT_VISITOR_DATA || ""),
  };

  const js = await fetchPlayerJs(hash);
  const declaredSts = Number((js.match(/signatureTimestamp[':\s"]+(\d{4,6})/) || [])[1]);
  const md5 = md5hash4(js);

  const checks = [];
  const fail = (name, detail) => checks.push({ name, ok: false, detail });
  const pass = (name, detail) => checks.push({ name, ok: true, detail });

  if (entry.sts !== declaredSts) {
    fail("sts-matches-base.js", `entry ${entry.sts} != base.js ${declaredSts}`);
  } else pass("sts-matches-base.js", String(declaredSts));

  const aliases = entry.aliases ?? [];
  if (md5 !== hash && !aliases.includes(md5)) {
    fail("md5-alias-present", `md5 ${md5} missing from aliases ${JSON.stringify(aliases)}`);
  } else pass("md5-alias-present", md5);

  // Gather distinct signatures, walking the video list until we have enough. Most ids are
  // bot-gated from datacenter IPs, so a failure here is "try the next id", not a verdict.
  const ciphers = [];
  const videoReport = [];
  for (const videoId of videos) {
    if (ciphers.length >= MIN_SIGNATURES) break;
    try {
      const r = await signatureCiphersFor(declaredSts, videoId, cred);
      videoReport.push({ videoId, playability: r.playability, ciphers: r.ciphers.length });
      ciphers.push(...r.ciphers);
    } catch (e) {
      videoReport.push({ videoId, error: e.message.slice(0, 60) });
    }
  }
  const distinct = [...new Set(ciphers)].slice(0, MIN_SIGNATURES);
  if (distinct.length < MIN_SIGNATURES) {
    fail("distinct-signatures", `got ${distinct.length}, need ${MIN_SIGNATURES}`);
    return report(false, { hash, entry, checks, videoReport, probes: [] });
  }
  pass("distinct-signatures", String(distinct.length));

  const cipher = await buildCipher(js, entry.sig, entry.nClass, nTrick);
  if (!cipher.nProbe.valid) {
    fail("n-transform-produces-valid-output", JSON.stringify(cipher.nProbe));
  } else pass("n-transform-produces-valid-output", "ok");

  const probes = [];
  for (const signatureCipher of distinct) {
    try {
      const url = cipher.deobfuscate(signatureCipher);
      probes.push(await probeCdn(url));
    } catch (e) {
      probes.push({ status: `deob-fail:${e.message.slice(0, 50)}`, valid: false, bytesRead: 0 });
    }
  }
  cipher.close();

  const allValid = probes.length === MIN_SIGNATURES && probes.every((p) => p.valid);
  if (!allValid) fail("all-signatures-return-206-with-bytes", JSON.stringify(probes.map((p) => p.status)));
  else pass("all-signatures-return-206-with-bytes", probes.map((p) => `${p.status}/${p.bytesRead}B`).join(" "));

  return report(
    checks.every((c) => c.ok),
    { hash, entry, checks, videoReport, probes },
  );
}

function report(ok, payload) {
  console.log(JSON.stringify({ ok, ...payload }, null, 2));
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.log(JSON.stringify({ ok: false, reason: e.message }, null, 2));
    process.exit(1);
  });
}
