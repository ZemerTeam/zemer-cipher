package com.zemer.cipher

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import timber.log.Timber
import java.io.File
import java.net.Proxy

object PlayerJsFetcher {
    private const val TAG = "Zemer_CipherFetcher"
    private const val IFRAME_API_URL = "https://www.youtube.com/iframe_api"
    private const val PLAYER_JS_URL_TEMPLATE = "https://www.youtube.com/s/player/%s/player_ias.vflset/en_GB/base.js"
    private const val CACHE_TTL_MS = 6 * 60 * 60 * 1000L // 6 hours

    var proxy: Proxy? = null

    /** STS of the currently cached player JS — must match what we send in API requests. */
    @Volatile
    var cachedSignatureTimestamp: Int? = null
        private set

    private val httpClient: OkHttpClient
        get() = OkHttpClient.Builder()
            .apply { proxy?.let { proxy(it) } }
            .build()

    // Regex to extract player hash from iframe_api response
    private val PLAYER_HASH_REGEX = Regex("""\\?/s\\?/player\\?/([a-zA-Z0-9_-]+)\\?/""")

    // Serializes cache mutations: getPlayerJs has UNsynchronized concurrent callers (prewarm,
    // signatureTimestamp() outside deobfuscateMutex, the app's EjsNTransformSolver), and an
    // unlocked writeToCache purge racing another writer's writeAtomic tmp window would delete
    // the tmp mid-write and silently degrade to a truncating non-atomic write.
    private val cacheWriteLock = Any()

    private fun getCacheDir(): File = File(CipherDeobfuscator.appContext.filesDir, "cipher_cache")

    private fun getCacheFile(hash: String): File = File(getCacheDir(), "player_$hash.js")

    private fun getHashFile(): File = File(getCacheDir(), "current_hash.txt")

    suspend fun getPlayerJs(forceRefresh: Boolean = false): Pair<String, String>? = withContext(Dispatchers.IO) {
        try {
            val cacheDir = getCacheDir()
            if (!cacheDir.exists()) cacheDir.mkdirs()

            // Check cache first (unless forced refresh)
            if (!forceRefresh) {
                val cached = readFromCache()
                if (cached != null) {
                    Timber.tag(TAG).d("Using cached player JS (hash=${cached.second})")
                    if (cachedSignatureTimestamp == null) {
                        cachedSignatureTimestamp = FunctionNameExtractor.extractSignatureTimestamp(cached.first, cached.second)
                        Timber.tag(TAG).d("STS from cached player: $cachedSignatureTimestamp")
                    }
                    return@withContext cached
                }
            }

            // Fetch player hash from iframe_api
            val hash = fetchPlayerHash()
            if (hash == null) {
                Timber.tag(TAG).e("Failed to extract player hash from iframe_api")
                return@withContext null
            }
            Timber.tag(TAG).d("Extracted player hash: $hash")

            // Download player JS
            val playerJs = downloadPlayerJs(hash)
            if (playerJs == null) {
                Timber.tag(TAG).e("Failed to download player JS for hash=$hash")
                return@withContext null
            }
            Timber.tag(TAG).d("Downloaded player JS: ${playerJs.length} chars")

            // Cache the result
            writeToCache(hash, playerJs)
            cachedSignatureTimestamp = FunctionNameExtractor.extractSignatureTimestamp(playerJs, hash)
            Timber.tag(TAG).d("STS from fresh player ($hash): $cachedSignatureTimestamp")

            Pair(playerJs, hash)
        } catch (e: Exception) {
            Timber.tag(TAG).e(e, "getPlayerJs exception: ${e.message}")
            null
        }
    }

    fun invalidateCache() {
        synchronized(cacheWriteLock) {
            try {
                val cacheDir = getCacheDir()
                if (cacheDir.exists()) {
                    cacheDir.listFiles()?.forEach { it.delete() }
                }
                Timber.tag(TAG).d("Cache invalidated")
            } catch (e: Exception) {
                Timber.tag(TAG).e(e, "Failed to invalidate cache: ${e.message}")
            }
        }
    }

    private fun readFromCache(): Pair<String, String>? {
        try {
            val hashFile = getHashFile()
            if (!hashFile.exists()) return null

            val hashData = hashFile.readText().split("\n")
            if (hashData.size < 2) return null

            val hash = hashData[0]
            val timestamp = hashData[1].toLongOrNull() ?: return null

            // Check TTL (withinWindow: a future timestamp from a backward clock step counts
            // as expired, not fresh).
            if (!PlayerConfigStore.withinWindow(System.currentTimeMillis(), timestamp, CACHE_TTL_MS)) {
                Timber.tag(TAG).d("Cache expired (hash=$hash)")
                return null
            }

            val cacheFile = getCacheFile(hash)
            if (!cacheFile.exists()) return null

            val playerJs = cacheFile.readText()
            if (playerJs.isEmpty()) return null

            return Pair(playerJs, hash)
        } catch (e: Exception) {
            Timber.tag(TAG).e(e, "Error reading cache: ${e.message}")
            return null
        }
    }

    private fun writeToCache(hash: String, playerJs: String) {
        synchronized(cacheWriteLock) {
            try {
                val cacheDir = getCacheDir()
                // Clean old cache files
                cacheDir.listFiles()?.filter { it.name.startsWith("player_") }?.forEach { it.delete() }

                // Atomic (temp + rename): a plain writeText truncates first, so process death
                // during a same-hash force-refresh rewrite would leave a truncated player.js
                // that readFromCache happily serves until the TTL expires.
                PlayerConfigStore.writeAtomic(getCacheFile(hash), playerJs)
                PlayerConfigStore.writeAtomic(getHashFile(), "$hash\n${System.currentTimeMillis()}")
            } catch (e: Exception) {
                Timber.tag(TAG).e(e, "Error writing cache: ${e.message}")
            }
        }
    }

    private fun fetchPlayerHash(): String? {
        val request = Request.Builder()
            .url(IFRAME_API_URL)
            .header("User-Agent", "Mozilla/5.0")
            .build()

        // .use{} so the response is closed on the error path too (an unread body would
        // otherwise strand its connection).
        val body = httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                Timber.tag(TAG).e("iframe_api HTTP ${response.code}")
                return null
            }
            response.body?.string()
        } ?: return null
        val match = PLAYER_HASH_REGEX.find(body)
        return match?.groupValues?.get(1)
    }

    private fun downloadPlayerJs(hash: String): String? {
        val url = PLAYER_JS_URL_TEMPLATE.format(hash)
        val request = Request.Builder()
            .url(url)
            .header("User-Agent", "Mozilla/5.0")
            .build()

        return httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                Timber.tag(TAG).e("player JS download HTTP ${response.code}")
                return null
            }
            response.body?.string()
        }
    }
}
