# zemer-cipher

Android library for YouTube cipher deobfuscation and PoToken generation.

**Scope:** this library deciphers web clients' sig/n and mints poTokens. Which stream clients are
chosen, and how each is tested for whole-song delivery past the CDN's 1-MiB free window, lives in
[`zemer-app`](https://github.com/ZemerTeam/zemer-app) (`YTPlayerUtils` + `tests/client-fulldownload.mjs`).

## Origin

The WebView signature-cipher / n-transform deciphering here (`CipherDeobfuscator`, `CipherWebView`,
the injected `window._cipherSigFunc`) was **originally written by me
([alltechdev](https://github.com/alltechdev))** - first implemented into [`zemer-app`](https://github.com/ZemerTeam/zemer-app) on
**2026-02-12**
([`f905d49`](https://github.com/ZemerTeam/zemer-app/commit/f905d49da8b4486b659fa32d68e2f45f939fb56a)).
This repository is that same code, extracted into a standalone Android library
(`com.zemer:cipher`).

**Remote config:** [`zemer-app`](https://github.com/ZemerTeam/zemer-app) fetches `player_configs.json`
from this repo's `master` at runtime (via `PlayerConfigStore`) to self-heal YouTube player rotations
without an app update.

## Features

- Signature cipher deobfuscation for YouTube streaming URLs
- N-parameter transformation to avoid throttling
- PoToken generation using BotGuard
- **Remote-updatable player configs** - a config pushed to this repo's `master` fixes
  deployed apps within minutes, no APK release needed

## Player configs (`library/src/main/assets/player_configs.json`)

YouTube rotates its `player_ias` JS frequently; each rotation needs a per-player config
(sig call expression, n-transform URL class, signatureTimestamp). All configs live in
**one JSON file**, which is:

1. **Bundled** in the APK as the offline default,
2. **Fetched at runtime** by `PlayerConfigStore` from this repo's raw `master` URL
   (6 h TTL + ETag), and **force-refreshed the moment an unknown player breaks
   deciphering** - so pushing a new entry to `master` is the deploy,
3. Read by the `zemer-app` test harness - app, devices, and tests cannot drift apart.

### Entry shape (schemaVersion 1)

```json
"445213fb": { "sig": "mP(4,155,INPUT)", "nClass": "Yx", "sts": 20613, "aliases": ["d62bd338"] }
```

- key - the 8-hex player hash from the player JS URL; `aliases` - the md5-of-first-10000-bytes
  fallback hash
- `sig` - the signature deobfuscation call, locked to `name(int,int,INPUT)`
- `nClass` - the URL class for the n-transform IIFE (built from a local template)
- `sts` - the player's signatureTimestamp

### Adding a rotated player

1. In `zemer-app`: `node tests/validate-player-config.mjs <hash>` - deciphers a real stream
   and checks the CDN returns **HTTP 206** (the only ground truth; multiple constant pairs
   can "decipher" while only one is accepted). It prints a paste-ready JSON entry.
2. Add the entry to `player_configs.json` here. Duplicate hashes/aliases reject the whole
   file - run the unit tests.
3. Push to `master` - deployed apps self-heal from that URL within minutes.
4. Bump the submodule pointer in `zemer-app` afterwards (bundled defaults stay fresh).

### Automated rotation

The steps above also run automatically. `.github/workflows/player-monitor.yml` watches for
`player_ias` rotations, derives each unknown config, validates it against the live CDN, and
(when enabled) commits it straight to `master`, so a rotation deploys without anyone editing
the file by hand. The deriver and validators live in `tools/` (`propose-config.mjs`,
`verify-entry.mjs`, `apply-entry.mjs`).

The pipeline is fail-closed. A hash reaches a commit only after two independent HTTP 206
checks (`propose-config`, then `verify-entry`) and a parser-parity gate, and the untrusted
player JS is evaluated only in an isolated job that holds no write credential. After the push
it re-reads the deployed file over git protocol and reverts only a commit it can prove is bad.

Deploy is gated by the `AUTO_DEPLOY_CONFIG` repository variable, which is also the kill
switch: unset validates and alerts only (writing nothing), `branch` commits to the branch the
run was triggered from, and `master` commits to `master` (the live deploy). The manual steps
above remain the fallback for adding a config by hand.

### Safety model

`PlayerConfigParser` is the validation boundary: every value is regex-locked so remote data
can never inject free-form JS into the cipher WebView. Invalid entries are skipped; invalid
files (including hash/alias collisions) are rejected wholesale and devices keep their
last-good table. Bump `schemaVersion` **only** on breaking shape changes - older apps reject
newer schema files and keep working from their last-good table.

Run the tests with `./gradlew :library:testDebugUnitTest`. The `config-parity/` fixtures are
shared with the `zemer-app` harness: file-level accept/reject verdicts (and the n-IIFE
template) are pinned byte-for-byte across both readers.

## Stream clients (`library/src/main/assets/stream_clients.json`)

The second remote table: the YouTube clients the app's stream resolution may use, their fallback
ORDER (entry 0 = main), per-client flags, which entries the SABR transport may use (`sabr`), and
the `enabled: false` kill switch. Same deploy model as the player configs — bundled in the APK,
fetched from this repo's master at runtime (`StreamClientStore`, 6 h TTL, plus a forced refresh
after a total resolution failure), read by the zemer-app harness (`tests/stream-clients.mjs`), and
pinned across the two readers by `src/test/resources/stream-clients-parity/`.

### Automated monitoring (`.github/workflows/client-monitor.yml`)

There is no upstream artifact to "scan" for clients the way `player_ias` hashes are scanned, so the
monitor measures the thing that matters directly: after every completed run of the player monitor
(`workflow_run`, rate-limited to one scan per `MIN_SCAN_INTERVAL_MINUTES`, default 60) and at
least every 3 h, it drains a whole song through EVERY known client on the validation videos, using the zemer-app harness (`tests/scan-stream-clients.mjs`
= the same `client-fulldownload.mjs` drain a human runs). The roster is dynamic — the table's live
entries, its benched entries, and every client the app retired (`tests/clients-retired.mjs`) — and
each outcome has one response:

| Observation (on every validation video) | Action |
|---|---|
| a live entry fails, two consecutive runs | **bench** it (`enabled: false`) and deploy |
| a benched entry drains whole songs on EVERY validation video, two consecutive runs | **un-bench** it and deploy |
| a `sabr`-capable entry fails over SABR on every video, two consecutive runs (`tests/sabr-clients.mjs` drain, the same scan) | **bench its SABR capability** (`sabr.enabled: false`) and deploy — the entry keeps streaming progressively and keeps its SABR identity overrides |
| a SABR-benched entry drains whole songs over SABR, two consecutive runs | **un-bench the SABR capability** and deploy |
| a retired client drains whole songs on EVERY validation video | issue *Retired client works again* (re-adding is a human, validated table change) |
| an entry's identity (clientVersion, userAgent, os/device) is behind yt-dlp master (`tests/scan-client-versions.mjs`, per the entry's `mirrors` key) | **bump** it: the entry is copied into a candidate table with yt-dlp's values (`tools/clients/apply-bump.mjs --out`), the candidate must drain a whole song on EVERY validation video, then it deploys; an unverified candidate only opens an *identity drift* issue with the reason |
| no client at all drained a whole song | issue *scan inconclusive*; nothing benched — the runner, cookie or cipher is suspect, not the table (a dead MAIN with healthy fallbacks is reported as dead — a human decision — and its yt-dlp bump can revive it) |
| "Sign in to confirm you're not a bot" on an anonymous request | `bot-gated` = INCONCLUSIVE (the runner's IP, not the client): never a kill, never a bench, never a verified bump |
| a sign-in demand for a client that WAS sent the cookie | `auth-failed` = INCONCLUSIVE (the session expired/revoked, not the client) + issue *cookie expired or revoked* — refresh `YT_COOKIE`; nothing benched on its account |
| every anonymous client fails while every cookie client drains whole | *anonymous egress suspect*: the runner, not three simultaneous deaths — inconclusive, alerted, nothing benched |

An identity bump of a `sabr`-capable entry must drain whole songs over BOTH transports before it
deploys. The open detection issues are the pipeline's memory: a client is benched only when its *failing*
issue was already open (at least `MIN_FLAG_AGE_MINUTES`, default 60) before the run — one bad
scan can never write. `tools/clients/decide.mjs` holds the rules (`clients.test.mjs`): the main is
never benched, at least `MIN_LIVE_FALLBACKS` (default 2) live fallbacks must remain, and
`tools/clients/apply-bench.mjs` (bench / un-bench: exactly ONE line) and `apply-bump.mjs`
(identity bump: only clientVersion / userAgent / osName / osVersion / deviceMake / deviceModel /
androidSdkVersion of ONE entry, values re-validated with the parser's shapes) are the only writers;
both re-parse the result with the harness loader and refuse anything else — a different key,
protocol, flag, order or entry can never change unattended. Deploy is gated by the repository
variable `AUTO_DEPLOY_CLIENTS` (unset = alert only, `branch`, `master`) with the same
read-back-and-revert step as the player pipeline; `CLIENT_HARNESS_REF` pins the zemer-app ref that
supplies the harness. Secrets: `YT_COOKIE` / `YT_VISITOR_DATA` / `YT_DATASYNC_ID` (login-required
clients are skipped without a cookie), `SCAN_PROXY` (a residential/mobile egress URL — GitHub's
runners are bot-gated for anonymous InnerTube requests, so without it the login-less clients stay
`bot-gated`/inconclusive and only the cookie-authenticated ones are judged), and the variable
`VALIDATION_VIDEO_IDS` (comma-separated; more videos = a stronger quorum). **Egress**: the scan job
connects Cloudflare WARP by default (`SCAN_EGRESS` = `warp` | `proxy` | `none`): GitHub's runners are
bot-gated for every anonymous request (`probe-bot-gate.yml` measured 2026-09-02: app-exact,
fresh-visitor and pot-carrying variants all gated from the bare runner), and only through a
residential-grade egress do the login-less clients get the app's own results. WARP's pools differ
by colo (ORD, DFW, LAX passed; IAD was gated), so the step VERIFIES the egress with one app-exact
anonymous `/player` (`probe-bot-gate.mjs` `QUICK=1`) and re-rolls the registration — alternating
the tunnel protocol — up to `EGRESS_ATTEMPTS` (default 2) times until it passes (IPv6 only: WARP's
IPv4 pool answered UNPLAYABLE where the same colo's v6 passed). The scan runs as SIX parallel egress
slots (six runners, six regions, six colos): only a slot whose egress verified - before AND
after its drains, with a `/player` plus a CDN range - drains, and `collect` MERGES every verified
slot (`tools/clients/merge-slots.mjs`): a whole song from any clean egress proves a client works, a
failure counts only when every clean egress agrees, so a false death needs every independent egress
to be wrong at once. A slot whose post-drain check fails is only partially trusted: its whole songs
still count (they happened), its failures do not. Slots 5-6 run on ARM-hosted runners (a second
Azure pool, other colos); identity-bump candidates are drained in slots 1-2 only. One gated colo no
longer costs a run. `node tools/clients/report-runs.mjs [N]` prints the last N runs' verified slots,
colos, merged verdicts and wall-clock - the reliability record. If no slot
verifies, the workflow re-dispatches itself on fresh runners, up to `MAX_RUNNER_ATTEMPTS`
(default 4) sets. A bot-gated verdict is
never accepted: either the egress is proven clean before a single drain, or the cycle ends with an
error and the next schedule tries again.
**Include gated content**: on
an ungated video (measured 2026-09-01 with `dQw4w9WgXcQ`) even the retired IOS, MWEB and ANDROID_VR
clients drain whole songs, progressively and over SABR. "Dead" needs failure on every video and
"revived / works again" needs a whole song on every video, so a validation set without a gated
video can neither bench a walled client nor keep one benched. The default `JTF9fLJvniI` is gated.

Entry field the harness reads and the app ignores: `mirrors` — the yt-dlp `INNERTUBE_CLIENTS` key
whose identity the entry follows (`web_music`, `visionos`, ...). An entry without it is pinned on
purpose (`VISIONOS_0_1`, the deliberately old second-chance config) and is never compared or bumped.

## Usage

### Initialization

```kotlin
// Initialize in your Application class
ZemerCipher.initialize(
    context = applicationContext,
    proxy = yourProxy,  // optional
    debugLogging = BuildConfig.DEBUG  // optional
)
```

### Cipher Deobfuscation

```kotlin
// Deobfuscate a signature cipher URL
val deobfuscatedUrl = CipherDeobfuscator.deobfuscateStreamUrl(signatureCipher, videoId)

// Transform n-parameter in URL
val transformedUrl = CipherDeobfuscator.transformNParamInUrl(url)
```

### PoToken Generation

```kotlin
val generator = PoTokenGenerator()
val result = generator.getWebClientPoToken(videoId, sessionId)
// result.playerRequestPoToken - for player requests
// result.streamingDataPoToken - for streaming data requests
```

## Credits

Almost all of this library is original work, written into `zemer-app` and extracted here
(see Origin above): the WebView signature-cipher and n-transform deciphering, the runtime
execution and script injection, the n-parameter transform logic, and the remote-updatable
config system that lets it self-heal (the `player_configs.json` schema, `PlayerConfigParser`,
`PlayerConfigStore`). The config deriver and live HTTP 206 validator that feed it live in
`zemer-app`. MetrolistGroup's
[`faraday`](https://github.com/MetrolistGroup/faraday) ports this config model, deriver, and
validator, and credits [`zemer-cipher`](https://github.com/ZemerTeam/zemer-cipher) and
[`zemer-app`](https://github.com/ZemerTeam/zemer-app) in its README. MetrolistGroup's
[`innertubex`](https://github.com/MetrolistGroup/innertubex) ships a port of the cipher solver
(its `ZemerCipherSolver` class) and lists Zemer among its cipher deobfuscation paths.

The automated CI rotation system (watch a `player_ias` rotation, then derive, live-validate, and
commit the config automatically) was built first by faraday in July 2026. The `tools/` pipeline
here is zemer-cipher's own later implementation of that idea (August 2026) on top of this format;
because devices already self-heal from `master`, a commit here is also the live deploy.

Two narrow pieces build on prior work and are credited here:

- The BotGuard poToken client follows [BgUtils](https://github.com/LuanRT/BgUtils)
  (MIT License) patterns.
- Reading YouTube's signature and n functions out of the player is a known deobfuscation
  technique, also documented by [yt-dlp](https://github.com/yt-dlp/yt-dlp),
  [NewPipe](https://github.com/TeamNewPipe/NewPipe), and others.

## License

GPL-3.0
