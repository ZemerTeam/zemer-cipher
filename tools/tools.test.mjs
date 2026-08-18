// Regression tests for the pure decision logic behind the automated rotation.
// No network, no jsdom, no credentials:  node --test tools/tools.test.mjs
//
// These cover the gates that stand between "a script found something" and "260,000 devices fetch
// a new config file": ambiguity refusal, entry shape, environment scrubbing, append-only writing,
// alias collisions, and what actually counts as a valid CDN response.

import test from "node:test";
import assert from "node:assert/strict";

import { interpretValidatorOutput, validateEntryShape, childEnv } from "./propose-config.mjs";
import {
  checkAppendOnly,
  checkNoCollision,
  coveredKeys,
  entryAlreadyCovered,
  serializeEntry,
  insertEntryLine,
} from "./apply-entry.mjs";
import { cdnResponseIsValid, isGoogleVideoPlaybackUrl } from "./verify-entry.mjs";

const HASH = "b0d2d49a";
const ENTRY_LINE =
  `    "${HASH}": { "sig": "EP(3,4223,INPUT)", "nClass": "eg", "sts": 20676, "aliases": ["6fd8f6f9"] }`;
const WORKS_LINE = "  sig=EP(3,4223,INPUT)     n=g.eg   nProbe.changed=true  GET=206  ✓ WORKS";

const CONFIG_TEXT = [
  "{",
  '  "schemaVersion": 1,',
  '  "players": {',
  '    "9c249f6f": { "sig": "Tl(48,5831,INPUT)", "nClass": "W_", "sts": 20602, "aliases": ["a6fc27c5"] },',
  '    "188a8916": { "sig": "hh(26,4464,INPUT)", "nClass": "sV", "sts": 20679, "aliases": ["e945a44c"] }',
  "  }",
  "}",
  "",
].join("\n");

// ---------------------------------------------------------------- propose (structured verdict)

const RESULT_OK = 'VALIDATOR_RESULT=' + JSON.stringify({
  ok: true, hash: HASH, workingCount: 1, ambiguous: false,
  entry: { sig: "EP(3,4223,INPUT)", nClass: "eg", sts: 20676, aliases: ["6fd8f6f9"] },
});

test("the structured VALIDATOR_RESULT line drives the verdict", () => {
  // Preferred over any scraped text — even human WORKS lines above it are ignored.
  const r = interpretValidatorOutput(HASH, [WORKS_LINE, RESULT_OK, ENTRY_LINE].join("\n"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry, { sig: "EP(3,4223,INPUT)", nClass: "eg", sts: 20676, aliases: ["6fd8f6f9"] });
});

test("structured ambiguous=true is refused regardless of the human text", () => {
  const line = 'VALIDATOR_RESULT=' + JSON.stringify({
    ok: false, hash: HASH, workingCount: 2, ambiguous: true, entry: null,
  });
  const r = interpretValidatorOutput(HASH, [WORKS_LINE, line].join("\n"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /ambiguous: 2/);
});

test("structured ok=false / no entry is refused", () => {
  const line = 'VALIDATOR_RESULT=' + JSON.stringify({ ok: false, hash: HASH, workingCount: 0, ambiguous: false, entry: null });
  const r = interpretValidatorOutput(HASH, line);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no candidate pair returned 206/);
});

test("structured line with a mismatched hash is refused", () => {
  const line = 'VALIDATOR_RESULT=' + JSON.stringify({
    ok: true, hash: "deadbeef", workingCount: 1, ambiguous: false,
    entry: { sig: "EP(3,4223,INPUT)", nClass: "eg", sts: 20676, aliases: ["6fd8f6f9"] },
  });
  const r = interpretValidatorOutput(HASH, line);
  assert.equal(r.ok, false);
  assert.match(r.reason, /hash/);
});

test("structured line whose entry fails the shape check is refused", () => {
  const line = 'VALIDATOR_RESULT=' + JSON.stringify({
    ok: true, hash: HASH, workingCount: 1, ambiguous: false,
    entry: { sig: "alert(1)//(1,2,INPUT)", nClass: "eg", sts: 20676, aliases: [] },
  });
  const r = interpretValidatorOutput(HASH, line);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------- propose (legacy scrape fallback)

test("fallback: a single working pair yields the parsed entry", () => {
  const r = interpretValidatorOutput(HASH, [WORKS_LINE, "", ENTRY_LINE].join("\n"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry, { sig: "EP(3,4223,INPUT)", nClass: "eg", sts: 20676, aliases: ["6fd8f6f9"] });
});

test("fallback: two nChanged=true pairs are refused as ambiguous", () => {
  const out = [WORKS_LINE, WORKS_LINE.replace("g.eg", "g.zz"), ENTRY_LINE].join("\n");
  const r = interpretValidatorOutput(HASH, out);
  assert.equal(r.ok, false);
  assert.match(r.reason, /ambiguous: 2/);
  assert.equal(r.workingPairs.length, 2);
});

test("fallback: a WORKS line with nProbe.changed=false is NOT counted (the #1 over-refusal fix)", () => {
  // A correct-sig / wrong-n candidate 206s in the 1 MiB free window and prints ✓ WORKS, but with
  // nProbe.changed=false. It must not inflate the ambiguity count against the one real winner.
  const wrongN = "  sig=EP(3,4223,INPUT)     n=g.zz   nProbe.changed=false  GET=206  ✓ WORKS";
  const r = interpretValidatorOutput(HASH, [WORKS_LINE, wrongN, ENTRY_LINE].join("\n"));
  assert.equal(r.ok, true, "the single nChanged=true pair is the unambiguous winner");
  assert.deepEqual(r.entry, { sig: "EP(3,4223,INPUT)", nClass: "eg", sts: 20676, aliases: ["6fd8f6f9"] });
});

test("fallback: no working pair is refused", () => {
  const r = interpretValidatorOutput(HASH, "  sig=EP(3,4223,INPUT) GET=403\n\n✗ no candidate");
  assert.equal(r.ok, false);
  assert.match(r.reason, /no candidate pair returned 206/);
});

test("fallback: a winner with no printed entry line is refused", () => {
  const r = interpretValidatorOutput(HASH, WORKS_LINE);
  assert.equal(r.ok, false);
  assert.match(r.reason, /printed no entry line/);
});

test("fallback: an entry line for a different hash is not accepted", () => {
  const r = interpretValidatorOutput(HASH, [WORKS_LINE, ENTRY_LINE.replace(HASH, "deadbeef")].join("\n"));
  assert.equal(r.ok, false);
});

test("entry shape rejects malformed fields", () => {
  const good = { sig: "EP(3,4223,INPUT)", nClass: "eg", sts: 20676, aliases: ["6fd8f6f9"] };
  assert.equal(validateEntryShape(HASH, good).ok, true);
  assert.equal(validateEntryShape(HASH, { ...good, sig: "EP(3,INPUT)" }).ok, false);
  assert.equal(validateEntryShape(HASH, { ...good, sig: "alert(1)//(1,2,INPUT)" }).ok, false);
  assert.equal(validateEntryShape(HASH, { ...good, nClass: "a-b" }).ok, false);
  assert.equal(validateEntryShape(HASH, { ...good, sts: 0 }).ok, false);
  assert.equal(validateEntryShape(HASH, { ...good, sts: "20676" }).ok, false);
  assert.equal(validateEntryShape(HASH, { ...good, aliases: ["nothex!!"] }).ok, false);
  assert.equal(validateEntryShape(HASH, { ...good, aliases: [HASH] }).ok, false, "alias == primary");
  assert.equal(validateEntryShape("NOTAHASH", good).ok, false);
});

test("a $ in the n-class is legal", () => {
  const entry = { sig: "EP(3,4223,INPUT)", nClass: "a$b", sts: 20676, aliases: [] };
  assert.equal(validateEntryShape(HASH, entry).ok, true);
});

test("child env forwards only the allowlist", () => {
  const env = childEnv({
    PATH: "/usr/bin",
    HOME: "/home/runner",
    YT_COOKIE: "SAPISID=x",
    GITHUB_TOKEN: "ghs_secret",
    ZEMER_APP_PRIVATE_KEY: "-----BEGIN",
    AWS_SECRET_ACCESS_KEY: "nope",
  });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH", "YT_COOKIE"]);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.ZEMER_APP_PRIVATE_KEY, undefined);
});

test("child env drops empty values rather than forwarding blanks", () => {
  assert.deepEqual(childEnv({ PATH: "/usr/bin", YT_COOKIE: "" }), { PATH: "/usr/bin" });
});

// ---------------------------------------------------------------- apply

test("covered keys include aliases, not just primaries", () => {
  const players = JSON.parse(CONFIG_TEXT).players;
  const keys = coveredKeys(players);
  assert.ok(keys.has("9c249f6f"));
  assert.ok(keys.has("a6fc27c5"), "alias counts as covered");
  assert.equal(keys.size, 4);
});

test("collision check rejects a hash or alias already covered", () => {
  const players = JSON.parse(CONFIG_TEXT).players;
  assert.equal(checkNoCollision(players, "9c249f6f", []).ok, false, "primary collision");
  assert.equal(checkNoCollision(players, "aaaaaaaa", ["a6fc27c5"]).ok, false, "alias collides");
  assert.equal(checkNoCollision(players, "a6fc27c5", []).ok, false, "new hash equals an alias");
  assert.equal(checkNoCollision(players, "aaaaaaaa", ["bbbbbbbb", "bbbbbbbb"]).ok, false, "dup aliases");
  assert.equal(checkNoCollision(players, "aaaaaaaa", ["bbbbbbbb"]).ok, true);
});

test("entryAlreadyCovered treats a primary OR alias hit as covered (the #4 noop fix)", () => {
  const players = JSON.parse(CONFIG_TEXT).players;
  // Primary already present -> covered (a hand-deploy of the same hash).
  assert.equal(entryAlreadyCovered(players, "9c249f6f", []), true, "primary present");
  // The entry's md5 alias is already covered (e.g. the first of two same-md5 skins in one batch
  // was applied moments ago) -> covered, so the second exits noop(0), never aborting the loop.
  assert.equal(entryAlreadyCovered(players, "ffffffff", ["a6fc27c5"]), true, "alias already covered");
  // A genuinely new hash+alias -> not covered (real work to do).
  assert.equal(entryAlreadyCovered(players, "ffffffff", ["eeeeeeee"]), false, "genuinely new");
});

test("append-only accepts exactly one addition", () => {
  const before = JSON.parse(CONFIG_TEXT);
  const after = JSON.parse(CONFIG_TEXT);
  after.players.aaaaaaaa = { sig: "EP(3,1,INPUT)", nClass: "eg", sts: 20680 };
  assert.equal(checkAppendOnly(before, after, "aaaaaaaa").ok, true);
});

test("append-only rejects removals, edits, extra adds and schema bumps", () => {
  const before = JSON.parse(CONFIG_TEXT);

  const removed = JSON.parse(CONFIG_TEXT);
  delete removed.players["9c249f6f"];
  removed.players.aaaaaaaa = { sig: "EP(3,1,INPUT)", nClass: "eg", sts: 1 };
  assert.match(checkAppendOnly(before, removed, "aaaaaaaa").reason, /removed/);

  const edited = JSON.parse(CONFIG_TEXT);
  edited.players["9c249f6f"].sts = 99999;
  edited.players.aaaaaaaa = { sig: "EP(3,1,INPUT)", nClass: "eg", sts: 1 };
  assert.match(checkAppendOnly(before, edited, "aaaaaaaa").reason, /was modified/);

  const twoAdds = JSON.parse(CONFIG_TEXT);
  twoAdds.players.aaaaaaaa = { sig: "EP(3,1,INPUT)", nClass: "eg", sts: 1 };
  twoAdds.players.bbbbbbbb = { sig: "EP(3,1,INPUT)", nClass: "eg", sts: 1 };
  assert.match(checkAppendOnly(before, twoAdds, "aaaaaaaa").reason, /exactly 1 new entry/);

  const bumped = JSON.parse(CONFIG_TEXT);
  bumped.schemaVersion = 2;
  bumped.players.aaaaaaaa = { sig: "EP(3,1,INPUT)", nClass: "eg", sts: 1 };
  assert.match(checkAppendOnly(before, bumped, "aaaaaaaa").reason, /schemaVersion changed/);
});

// ---------------------------------------------------------------- serialization

test("serialized entry matches the committed one-line format", () => {
  const line = serializeEntry(HASH, {
    sig: "EP(3,4223,INPUT)",
    nClass: "eg",
    sts: 20676,
    aliases: ["6fd8f6f9"],
  });
  assert.equal(line, ENTRY_LINE);
});

test("an entry with no aliases omits the aliases key", () => {
  const line = serializeEntry(HASH, { sig: "EP(3,4223,INPUT)", nClass: "eg", sts: 20676, aliases: [] });
  assert.equal(line, `    "${HASH}": { "sig": "EP(3,4223,INPUT)", "nClass": "eg", "sts": 20676 }`);
});

test("insertion adds the trailing comma and touches nothing else", () => {
  const next = insertEntryLine(CONFIG_TEXT, HASH, {
    sig: "EP(3,4223,INPUT)",
    nClass: "eg",
    sts: 20676,
    aliases: ["6fd8f6f9"],
  });
  const parsed = JSON.parse(next);
  assert.equal(Object.keys(parsed.players).length, 3);
  assert.deepEqual(parsed.players["9c249f6f"], JSON.parse(CONFIG_TEXT).players["9c249f6f"]);

  const beforeLines = CONFIG_TEXT.split("\n");
  const afterLines = next.split("\n");
  // Exactly one line added; the only pre-existing line that may change is the previous last
  // entry, and only by gaining a comma.
  assert.equal(afterLines.length, beforeLines.length + 1);
  assert.equal(afterLines[4], beforeLines[4] + ",");
  assert.equal(afterLines[5], ENTRY_LINE);
});

test("insertion refuses a file with no player lines", () => {
  assert.throws(() => insertEntryLine('{"schemaVersion":1,"players":{}}', HASH, {}), /no existing player lines/);
});

// ---------------------------------------------------------------- CDN verdict

test("only a real audio 206 off googlevideo counts", () => {
  const good = {
    status: 206,
    contentType: "audio/mp4",
    contentRange: "bytes 0-262143/5000000",
    finalUrl: "https://rr3---sn-abc.googlevideo.com/videoplayback?x=1",
    bytesRead: 4096,
  };
  assert.equal(cdnResponseIsValid(good), true);
  assert.equal(cdnResponseIsValid({ ...good, status: 200 }), false, "200 is not a range response");
  assert.equal(cdnResponseIsValid({ ...good, status: 403 }), false);
  assert.equal(cdnResponseIsValid({ ...good, contentType: "text/html" }), false, "an error page");
  assert.equal(cdnResponseIsValid({ ...good, contentRange: null }), false);
  assert.equal(cdnResponseIsValid({ ...good, bytesRead: 0 }), false, "headers only, no bytes");
  assert.equal(
    cdnResponseIsValid({ ...good, finalUrl: "https://example.com/videoplayback" }),
    false,
    "redirected off the CDN",
  );
});

test("googlevideo URL check is host- and path-exact", () => {
  assert.equal(isGoogleVideoPlaybackUrl("https://r1---sn-x.googlevideo.com/videoplayback?a=1"), true);
  assert.equal(isGoogleVideoPlaybackUrl("http://r1---sn-x.googlevideo.com/videoplayback"), false, "http");
  assert.equal(isGoogleVideoPlaybackUrl("https://googlevideo.com.evil.tld/videoplayback"), false);
  assert.equal(isGoogleVideoPlaybackUrl("https://r1---sn-x.googlevideo.com/other"), false);
  assert.equal(isGoogleVideoPlaybackUrl("not a url"), false);
});
