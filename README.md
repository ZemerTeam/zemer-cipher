# zemer-cipher

Android library for YouTube cipher deobfuscation and PoToken generation.

## Features

- Signature cipher deobfuscation for YouTube streaming URLs
- N-parameter transformation to avoid throttling
- PoToken generation using BotGuard

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

- PoToken generation patterns based on [BgUtils](https://github.com/nichobi/bgutils) (MIT License)
- Cipher function extraction uses standard YouTube deobfuscation techniques (as documented by yt-dlp, NewPipe, etc.)

All other code (WebView implementation, runtime execution, n-parameter transform logic) is custom implementation.

## License

GPL-3.0
