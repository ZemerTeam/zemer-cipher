# zemer-cipher

Android library for YouTube cipher deobfuscation and PoToken generation.

## Origin & adoption

The WebView signature-cipher / n-transform deciphering here (`CipherDeobfuscator`, `CipherWebView`,
the injected `window._cipherSigFunc`) was **originally written by me
([alltechdev](https://github.com/alltechdev))** — first implemented into [`zemer-app`](https://github.com/ZemerTeam/zemer-app) on
**2026-02-12**
([`f905d49`](https://github.com/ZemerTeam/zemer-app/commit/f905d49da8b4486b659fa32d68e2f45f939fb56a)),
then added to [Metrolist](https://github.com/MetrolistGroup/Metrolist) two days later on **2026-02-14**
([`0750a63d`](https://github.com/MetrolistGroup/Metrolist/commit/0750a63d74d69082b81ae8868b06edab51fb3875))
This repository is that same code, extracted into a standalone Android library
(`com.zemer:cipher`).

**Remote config:** [`zemer-app`](https://github.com/ZemerTeam/zemer-app),  [Metrolist](https://github.com/MetrolistGroup/Metrolist), and [Echo-Music](https://github.com/EchoMusicApp/Echo-Music) fetch `player_configs.json` from this repo's `master`
at runtime (via `PlayerConfigStore`) to self-heal YouTube player rotations without an app update.

**Code reuse:** the deciphering code has also been copied into many other projects — these bundle the
code only and do **not** pull config updates from here. Verified examples:

- [Flow](https://github.com/A-EDev/Flow)
- [vivi-music](https://github.com/vivizzz007/vivi-music)
- [Kreate](https://github.com/knighthat/Kreate)
- [Meld](https://github.com/FrancescoGrazioso/Meld)

…plus dozens of other forks and derivative apps.

## Features

- Signature cipher deobfuscation for YouTube streaming URLs
- N-parameter transformation to avoid throttling
- PoToken generation using BotGuard
- **Remote-updatable player configs** — a config pushed to this repo's `master` fixes
  deployed apps within minutes, no APK release needed

## Player configs (`library/src/main/assets/player_configs.json`)

YouTube rotates its `player_ias` JS frequently; each rotation needs a per-player config
(sig call expression, n-transform URL class, signatureTimestamp). All configs live in
**one JSON file**, which is:

1. **Bundled** in the APK as the offline default,
2. **Fetched at runtime** by `PlayerConfigStore` from this repo's raw `master` URL
   (6 h TTL + ETag), and **force-refreshed the moment an unknown player breaks
   deciphering** — so pushing a new entry to `master` is the deploy,
3. Read by the `zemer-app` test harness — app, devices, and tests cannot drift apart.

### Entry shape (schemaVersion 1)

```json
"445213fb": { "sig": "mP(4,155,INPUT)", "nClass": "Yx", "sts": 20613, "aliases": ["d62bd338"] }
```

- key — the 8-hex player hash from the player JS URL; `aliases` — the md5-of-first-10000-bytes
  fallback hash
- `sig` — the signature deobfuscation call, locked to `name(int,int,INPUT)`
- `nClass` — the URL class for the n-transform IIFE (built from a local template)
- `sts` — the player's signatureTimestamp

### Adding a rotated player

1. In `zemer-app`: `node tests/validate-player-config.mjs <hash>` — deciphers a real stream
   and checks the CDN returns **HTTP 206** (the only ground truth; multiple constant pairs
   can "decipher" while only one is accepted). It prints a paste-ready JSON entry.
2. Add the entry to `player_configs.json` here. Duplicate hashes/aliases reject the whole
   file — run the unit tests.
3. Push to `master` — deployed apps self-heal from that URL within minutes.
4. Bump the submodule pointer in `zemer-app` afterwards (bundled defaults stay fresh).

### Safety model

`PlayerConfigParser` is the validation boundary: every value is regex-locked so remote data
can never inject free-form JS into the cipher WebView. Invalid entries are skipped; invalid
files (including hash/alias collisions) are rejected wholesale and devices keep their
last-good table. Bump `schemaVersion` **only** on breaking shape changes — older apps reject
newer schema files and keep working from their last-good table.

Run the tests with `./gradlew :library:testDebugUnitTest`. The `config-parity/` fixtures are
shared with the `zemer-app` harness: file-level accept/reject verdicts (and the n-IIFE
template) are pinned byte-for-byte across both readers.

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

- PoToken generation patterns based on [BgUtils](https://github.com/LuanRT/BgUtils) (MIT License)
- Cipher function extraction uses standard YouTube deobfuscation techniques (as documented by yt-dlp, NewPipe, etc.)

All other code (WebView implementation, runtime execution, n-parameter transform logic) is custom implementation.

## License

GPL-3.0
