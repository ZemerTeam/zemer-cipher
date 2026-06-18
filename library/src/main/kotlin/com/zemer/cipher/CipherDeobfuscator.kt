package com.zemer.cipher

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import timber.log.Timber

object CipherDeobfuscator {
    private const val TAG = "Zemer_CipherDeobfusc"

    lateinit var appContext: Context
        private set

    fun initialize(context: Context) {
        appContext = context.applicationContext
    }

    private var cipherWebView: CipherWebView? = null
    private var currentPlayerHash: String? = null

    // The PlayerConfigStore.configEpoch the cached WebView was built under. When the config table
    // changes (epoch advances), the cached WebView may have been built from a missing or wrong
    // config for the current player, so getOrCreateWebView() rebuilds it instead of trusting it for
    // the life of the process — the staleness that previously required an app restart to recover.
    private var builtConfigEpoch = -1

    /**
     * The `player_ias` hash last used to decipher a web stream (sig/n), or null if none yet.
     * Diagnostic only — surfaced in the song-details sheet. Direct-URL clients
     * (ANDROID_VR/IOS) never run the cipher, so this reflects the last *web* stream.
     */
    val lastUsedPlayerHash: String?
        get() = currentPlayerHash
    // CipherWebView has single-shot continuation slots — serialize all calls
    private val deobfuscateMutex = Mutex()

    /**
     * SignatureTimestamp of the player JS this cipher will actually decipher with, fetching
     * (or reusing the cached) player JS if needed. API callers must send THIS value in the
     * /player request: during A/B rollouts other sources (e.g. NewPipe's own player fetch)
     * can land on a different player generation, and a sig minted for one player deciphered
     * by another produces a URL the CDN 403s.
     */
    suspend fun signatureTimestamp(): Int? {
        PlayerJsFetcher.getPlayerJs(forceRefresh = false) ?: return null
        return PlayerJsFetcher.cachedSignatureTimestamp
    }

    /**
     * Best-effort: create the cipher WebView (fetch player JS + load it) ahead of first playback so
     * the deobfuscation hot path is already warm. Guarded by the same mutex as deobfuscation, so it
     * can't race a real request; on failure the WebView is simply created lazily on first use.
     */
    suspend fun prewarm() {
        Timber.tag(TAG).d("Prewarming cipher WebView...")
        deobfuscateMutex.withLock {
            getOrCreateWebView(forceRefresh = false)
        }
    }

    suspend fun deobfuscateStreamUrl(signatureCipher: String, videoId: String): String? = deobfuscateMutex.withLock {
        try {
            deobfuscateInternal(signatureCipher, videoId, isRetry = false)
        } catch (e: Exception) {
            Timber.tag(TAG).e(e, "Cipher deobfuscation failed, retrying with fresh JS: ${e.message}")
            try {
                PlayerJsFetcher.invalidateCache()
                closeWebView()
                deobfuscateInternal(signatureCipher, videoId, isRetry = true)
            } catch (retryE: Exception) {
                Timber.tag(TAG).e(retryE, "Cipher deobfuscation retry also failed: ${retryE.message}")
                null
            }
        }
    }

    /**
     * Called when a deciphered stream URL was rejected by the CDN (e.g. a WEB_REMIX 403). A wrong
     * signature that the player JS computes WITHOUT throwing — a stale/wrong player config or a
     * legacy-regex false positive — is invisible to [deobfuscateStreamUrl]'s exception-retry, so
     * the rejected stream is the only signal it was wrong. Re-fetch the player-config table
     * (rate-limited); if it changes, [PlayerConfigStore.configEpoch] advances and the next decipher
     * rebuilds the WebView from the corrected config, recovering WEB_REMIX without an app restart.
     * Returns whether the config table changed.
     */
    suspend fun onStreamRejected(): Boolean = PlayerConfigStore.refreshAfterStreamRejection()

    private suspend fun deobfuscateInternal(signatureCipher: String, videoId: String, isRetry: Boolean): String? {
        // Parse the signatureCipher query string
        val params = parseQueryParams(signatureCipher)
        val obfuscatedSig = params["s"]
        val sigParam = params["sp"] ?: "signature"
        val baseUrl = params["url"]

        if (obfuscatedSig == null || baseUrl == null) {
            Timber.tag(TAG).e("Could not parse signatureCipher params: s=${obfuscatedSig != null}, url=${baseUrl != null}")
            return null
        }

        Timber.tag(TAG).d("Deobfuscating cipher for $videoId: sig=${obfuscatedSig.take(20)}..., sp=$sigParam")

        val webView = getOrCreateWebView(forceRefresh = isRetry)
            ?: return null

        // Deobfuscate signature
        val deobfuscatedSig = webView.deobfuscateSignature(obfuscatedSig)

        // Build the URL with deobfuscated signature
        val separator = if ("?" in baseUrl) "&" else "?"
        val finalUrl = "$baseUrl${separator}${sigParam}=${Uri.encode(deobfuscatedSig)}"

        Timber.tag(TAG).d("Custom cipher deobfuscation succeeded for $videoId")
        return finalUrl
    }

    /**
     * Transform the 'n' parameter in a streaming URL to avoid throttling/403.
     * Uses the runtime-discovered n-function from the player JS WebView.
     * Returns the URL with the transformed 'n' value, or the original URL if transform fails.
     */
    suspend fun transformNParamInUrl(url: String): String = deobfuscateMutex.withLock {
        // Hold the same mutex as deobfuscateStreamUrl/prewarm: the shared CipherWebView has
        // single-shot continuation slots, so sig deciphering, n-transform, and warm-up must never
        // touch it concurrently (concurrent calls would clobber each other's WebView state).
        try {
            transformNInternal(url)
        } catch (e: Exception) {
            Timber.tag(TAG).e(e, "N-transform failed, returning original URL: ${e.message}")
            url
        }
    }

    private suspend fun transformNInternal(url: String): String {
        // Extract the 'n' parameter value from the URL
        val nMatch = Regex("[?&]n=([^&]+)").find(url)
        if (nMatch == null) {
            Timber.tag(TAG).d("No 'n' parameter found in URL, skipping transform")
            return url
        }
        val nValue = Uri.decode(nMatch.groupValues[1])
        Timber.tag(TAG).d("N-param found: $nValue")

        val webView = getOrCreateWebView(forceRefresh = false) ?: return url

        if (!webView.nFunctionAvailable) {
            Timber.tag(TAG).e("N-transform function was not discovered at init time")
            return url
        }

        val transformedN = webView.transformN(nValue)
        Timber.tag(TAG).d("N-param transformed: $nValue -> $transformedN")

        // Replace n= parameter in URL
        return url.replaceFirst(
            Regex("([?&])n=[^&]+"),
            "$1n=${Uri.encode(transformedN)}"
        )
    }

    private suspend fun getOrCreateWebView(forceRefresh: Boolean): CipherWebView? {
        // Snapshot the epoch BEFORE extracting/building. A refresh that lands on another thread
        // during this (multi-second) build then leaves builtConfigEpoch behind the live epoch,
        // forcing a rebuild on the next decipher instead of masking the change. Capturing the epoch
        // AFTER the build would record a config this WebView never actually incorporated — the
        // staleness this whole mechanism exists to prevent.
        val epochAtStart = PlayerConfigStore.configEpoch
        if (!forceRefresh && cipherWebView != null && builtConfigEpoch == epochAtStart) {
            return cipherWebView
        }

        // The epoch whose config this build incorporates. Defaults to the pre-build snapshot; the
        // incomplete-extraction path below advances it only after a same-thread forceRefresh whose
        // new config we re-extract and therefore HAVE incorporated (avoids a needless next rebuild).
        var builtEpoch = epochAtStart

        // Close existing WebView if any
        if (cipherWebView != null) {
            closeWebView()
        }

        // Fetch player JS
        val result = PlayerJsFetcher.getPlayerJs(forceRefresh = forceRefresh)
        if (result == null) {
            Timber.tag(TAG).e("Failed to get player JS")
            return null
        }
        val (playerJs, hash) = result

        // Extract signature function info — null is OK, WebView can still be used for n-transform.
        // Pass the fetcher's URL hash so hardcoded-config lookup uses the primary key instead of
        // falling back to the MD5-of-first-10000-bytes alias.
        var sigInfo = FunctionNameExtractor.extractSigFunctionInfo(playerJs, hash)
        if (sigInfo == null) {
            Timber.tag(TAG).w("Could not extract signature function info — proceeding with n-transform only")
        }

        // Extract n-transform function info (for throttle avoidance / 403 fix)
        var nFuncInfo = FunctionNameExtractor.extractNFunctionInfo(playerJs, hash)
        if (nFuncInfo == null) {
            Timber.tag(TAG).e("Could not extract n-function info from player JS (will try brute-force)")
        }

        // Incomplete extraction: a rotated player_ias whose config may already be published
        // remotely. Force a config refresh and re-extract once — this is what fixes users
        // without an APK update, mid-session, at the exact moment playback would otherwise
        // break. EITHER side missing triggers it: a legacy-regex false positive on one side
        // must not block recovery of the other, and after a successful refresh both sides
        // re-extract so a validated config replaces any heuristic guess.
        if (sigInfo == null || nFuncInfo == null) {
            Timber.tag(TAG).w("Incomplete extraction for player $hash (sig=${sigInfo != null}, n=${nFuncInfo != null}) — forcing remote config refresh")
            if (PlayerConfigStore.forceRefresh(missingHash = hash)) {
                sigInfo = FunctionNameExtractor.extractSigFunctionInfo(playerJs, hash) ?: sigInfo
                nFuncInfo = FunctionNameExtractor.extractNFunctionInfo(playerJs, hash) ?: nFuncInfo
                builtEpoch = PlayerConfigStore.configEpoch
            }
        }

        // Nothing useful to put in a WebView if both are null
        if (sigInfo == null && nFuncInfo == null) {
            Timber.tag(TAG).e("Neither sig nor n-function could be extracted — skipping WebView creation")
            return null
        }

        Timber.tag(TAG).d("Creating CipherWebView with sig=${sigInfo?.name}, constantArg=${sigInfo?.constantArg}, nFunc=${nFuncInfo?.name}[${nFuncInfo?.arrayIndex}]")

        // Create WebView — n-function is exported to window if found, with brute-force fallback
        val webView = CipherWebView.create(
            context = appContext,
            playerJs = playerJs,
            sigInfo = sigInfo,
            nFuncInfo = nFuncInfo,
        )

        cipherWebView = webView
        currentPlayerHash = hash
        builtConfigEpoch = builtEpoch
        return webView
    }

    private suspend fun closeWebView() {
        withContext(Dispatchers.Main) {
            cipherWebView?.close()
        }
        cipherWebView = null
        currentPlayerHash = null
    }

    private fun parseQueryParams(query: String): Map<String, String> {
        val result = mutableMapOf<String, String>()
        for (pair in query.split("&")) {
            val idx = pair.indexOf('=')
            if (idx > 0) {
                val key = Uri.decode(pair.substring(0, idx))
                val value = Uri.decode(pair.substring(idx + 1))
                result[key] = value
            }
        }
        return result
    }
}
