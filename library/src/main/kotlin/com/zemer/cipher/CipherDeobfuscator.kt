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
    suspend fun transformNParamInUrl(url: String): String {
        return try {
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
        if (!forceRefresh && cipherWebView != null) {
            return cipherWebView
        }

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

        // Unknown player: a rotated player_ias whose config may already be published remotely.
        // Force a config refresh and re-extract once — this is what fixes users without an APK
        // update, mid-session, at the exact moment playback would otherwise break.
        if (sigInfo == null && nFuncInfo == null) {
            Timber.tag(TAG).w("Unknown player $hash — forcing remote config refresh")
            if (PlayerConfigStore.forceRefresh()) {
                sigInfo = FunctionNameExtractor.extractSigFunctionInfo(playerJs, hash)
                nFuncInfo = FunctionNameExtractor.extractNFunctionInfo(playerJs, hash)
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
