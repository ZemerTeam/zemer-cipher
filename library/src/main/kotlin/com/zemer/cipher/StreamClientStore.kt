package com.zemer.cipher

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Request
import timber.log.Timber
import java.io.File

/**
 * Owns the stream-client table at runtime — the [PlayerConfigStore] pattern applied to the client
 * registry: bundled asset as the offline default, refreshed from the same JSON on zemer-cipher
 * `master` so a dead/rotated YouTube client is fixed on deployed apps without an APK update.
 *
 * ONE deliberate divergence from [PlayerConfigStore]: a valid remote file REPLACES the table
 * wholesale instead of merging per key. Removal and reordering are primary use cases here — a
 * per-key merge would resurrect removed clients and scramble the fallback order. Anything invalid
 * keeps the previous table (cached remote if present, else bundled); the parser's
 * never-zero-clients rule guarantees an applied table is never empty.
 *
 * Read path is lock-free: an immutable config behind a @Volatile reference, swapped wholesale.
 */
object StreamClientStore {
    private const val TAG = "Zemer_StreamClients"
    private const val ASSET_NAME = "stream_clients.json"
    // TESTING ONLY - REVERT BEFORE MERGE: pinned to the feature branch so the full remote
    // fetch/apply/update loop is testable pre-merge. The shipped value fetches master.
    private const val REMOTE_URL =
        "https://raw.githubusercontent.com/ZemerTeam/zemer-cipher/feat/remote-stream-clients/library/src/main/assets/stream_clients.json"

    private const val REFRESH_TTL_MS = 6 * 60 * 60 * 1000L

    // A cached remote table REPLACES the bundled one wholesale, so without a bound a device that
    // synced once and then can never reach the config host again (e.g. a filter that blocks
    // raw.githubusercontent) would keep that frozen table FOREVER, masking newer bundled tables
    // arriving via APK updates. Past this age the cache is treated as dead and bundled wins
    // (the offline-subset 14-day staleness-cap precedent). A healthy device re-stamps the cache
    // every successful sync (200 or 304), so only persistently-unreachable devices ever hit this.
    private const val CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000L

    // Failure-triggered refreshes (all stream clients failed for a resolution) are rate-limited so
    // a video that fails for unrelated reasons doesn't turn every retry into a GitHub request.
    private const val FAILURE_REFRESH_COOLDOWN_MS = 5 * 60 * 1000L

    // Names must not start with "player_" — PlayerJsFetcher.writeToCache()/invalidateCache() purge
    // player_* files from the shared cipher_cache dir; these must survive decipher retries.
    private const val CACHE_FILE = "stream_clients_remote.json"
    private const val META_FILE = "stream_clients_remote.meta"

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var bundledConfig: StreamClientParser.StreamClientConfig? = null

    @Volatile
    private var activeConfig: StreamClientParser.StreamClientConfig? = null

    /** Advanced whenever a remote refresh actually changes the table (observability/tests). */
    @Volatile
    var configEpoch: Int = 0
        private set

    /**
     * Wall-clock ms of the last successful remote sync (a 200 applied OR a 304 not-modified — both
     * mean the active table matches the deploy channel as of that moment); 0 = never synced this
     * install (e.g. offline, or the file not on master yet). Persisted via the meta file and
     * re-seeded at [initialize], so the Stream Sources screen can show "Updated <time>".
     */
    @Volatile
    var lastSyncedMs: Long = 0L
        private set

    @Volatile
    private var lastFailureAttemptMs = 0L

    // True when the most recent fetch got ANY HTTP response. The cooldown only arms in that case —
    // it protects the config host from repeat hits, not recovery after a pure network failure.
    @Volatile
    private var lastAttemptReachedServer = false

    private val refreshMutex = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    internal fun failureCooldownActive(now: Long) =
        PlayerConfigStore.withinWindow(now, lastFailureAttemptMs, FAILURE_REFRESH_COOLDOWN_MS)

    // Test-only seams (the PlayerConfigStore pattern).
    internal var cacheDirForTest: File? = null

    internal fun armFailureCooldownForTest(ms: Long) { lastFailureAttemptMs = ms }

    internal fun setLastSyncedForTest(ms: Long) { lastSyncedMs = ms }

    internal fun setConfigForTest(config: StreamClientParser.StreamClientConfig?) {
        activeConfig = config
    }

    internal fun setBundledForTest(config: StreamClientParser.StreamClientConfig?) {
        bundledConfig = config
    }

    /**
     * Synchronous: loads the bundled asset and, if present and valid, the last-good cached remote
     * copy. Cheap (one small asset + at most one small file), so a table exists before any lookup.
     */
    fun initialize(context: Context) {
        appContext = context.applicationContext

        bundledConfig = parseSource("bundled asset") { loadBundledJson(context) }
        if (bundledConfig == null) {
            Timber.tag(TAG).e("Bundled $ASSET_NAME missing or invalid — stream-client table starts empty")
        } else {
            Timber.tag(TAG).d("Loaded bundled stream clients (${bundledConfig?.clients?.size} entries)")
        }

        applyCachedOverlay()
        seedLastSyncedFromMeta()
    }

    /**
     * Seeds [lastSyncedMs] from the persisted meta. MUST run AFTER [applyCachedOverlay]: the
     * overlay deletes the meta whenever it drops the cache (stale/corrupt/invalid), so only then
     * is a surviving stamp a truthful last-sync time for the table that is actually active.
     * Reading it BEFORE the overlay would report "updated 20 days ago" while running the bundled
     * table — the exact lie the staleness cap exists to prevent.
     */
    internal fun seedLastSyncedFromMeta() {
        lastSyncedMs = readMeta()?.second ?: 0L
    }

    /**
     * Activates the last-good cached remote copy (which REPLACES bundled — see the class doc), or
     * falls back to bundled. On ANY failure to load the cache, the body AND meta are deleted
     * together: an ETag surviving a corrupt/missing body would 304 every conditional fetch and
     * lock the device on bundled-only clients until the remote content happens to change.
     */
    internal fun applyCachedOverlay() {
        // Staleness cap: an over-age cache (or one whose meta/stamp is missing/corrupt — no way
        // to prove freshness) is dead. A stamp in the FUTURE (the clock stepped backwards: an
        // epoch boot before NTP, a manual change) proves nothing about age, so it counts as fresh —
        // treating it as expired would purge a valid last-good table on every such launch and
        // re-stamp it with the bogus early time, purging it again once the clock is corrected.
        val now = System.currentTimeMillis()
        val syncStamp = readMeta()?.second
        val cacheFresh = syncStamp != null &&
            (syncStamp > now || PlayerConfigStore.withinWindow(now, syncStamp, CACHE_MAX_AGE_MS))
        val cached = if (cacheFresh) {
            parseSource("cached remote copy") { cacheFile()?.takeIf { it.exists() }?.readText() }
        } else {
            if (cacheFile()?.exists() == true) {
                Timber.tag(TAG).w("Cached remote stream clients are stale/unstamped — falling back to bundled")
            }
            null
        }
        activeConfig = if (cached != null) {
            Timber.tag(TAG).d("Using cached remote stream clients (${cached.clients.size} entries)")
            cached
        } else {
            cacheFile()?.delete()
            metaFile()?.delete()
            bundledConfig
        }
    }

    /** Non-blocking TTL-gated refresh, kicked once at startup. */
    fun scheduleStartupRefresh() {
        scope.launch {
            try {
                refreshIfStale()
            } catch (e: Exception) {
                Timber.tag(TAG).w(e, "Startup stream-client refresh failed: ${e.message}")
            }
        }
    }

    /**
     * The current table, or null when neither the bundled asset nor a cached remote copy could be
     * loaded (callers fall back to their compiled-in defaults — the floor below the floor).
     */
    fun config(): StreamClientParser.StreamClientConfig? = activeConfig

    /**
     * Failure-triggered refresh: EVERY client failed for a stream resolution, which is what a
     * YouTube-side client kill looks like. Fire-and-forget from the resolution path (never blocks
     * playback fallout), cooldown-gated, single-flight. Returns whether the table changed — the
     * next resolution reads the corrected table automatically (resolutions snapshot per call).
     */
    suspend fun refreshAfterResolutionFailure(): Boolean = withContext(Dispatchers.IO) {
        refreshMutex.withLock {
            val now = System.currentTimeMillis()
            if (failureCooldownActive(now)) {
                Timber.tag(TAG).d("refreshAfterResolutionFailure skipped (cooldown)")
                return@withLock false
            }
            lastFailureAttemptMs = now
            val changed = fetchAndApply()
            // A pure network failure (server never reached) resets the cooldown so a client kill
            // hit while briefly offline retries on the next trigger instead of waiting it out.
            if (!lastAttemptReachedServer) lastFailureAttemptMs = 0L
            changed
        }
    }

    private suspend fun refreshIfStale() {
        val lastFetchMs = readMeta()?.second ?: 0L
        // Persisted stamp: a future value (clock stepped back after the write) must count as
        // stale, not fresh — withinWindow handles that.
        if (PlayerConfigStore.withinWindow(System.currentTimeMillis(), lastFetchMs, REFRESH_TTL_MS)) {
            Timber.tag(TAG).d("Remote stream clients fresh (fetched ${System.currentTimeMillis() - lastFetchMs} ms ago)")
            return
        }
        withContext(Dispatchers.IO) {
            refreshMutex.withLock { fetchAndApply() }
        }
    }

    /**
     * Fetches the remote JSON (with If-None-Match) and applies it when valid. Any failure — HTTP
     * error (including the 404 served until the file lands on the repo's default branch), network
     * exception, or validation failure — keeps the previous table and cache. lastFetchMs advances
     * only on 200/304 so transient failures retry on the next trigger.
     */
    private fun fetchAndApply(): Boolean {
        lastAttemptReachedServer = false
        try {
            val etag = readMeta()?.first
            val request = Request.Builder()
                .url(REMOTE_URL)
                .header("User-Agent", "Mozilla/5.0")
                .apply { if (!etag.isNullOrEmpty()) header("If-None-Match", etag) }
                .build()

            ZemerCipher.httpClient.newCall(request).execute().use { response ->
                lastAttemptReachedServer = true
                if (response.code == 304) {
                    // 304 == the active table still matches the deploy channel: a successful sync.
                    Timber.tag(TAG).d("Remote stream clients unchanged (304)")
                    lastSyncedMs = System.currentTimeMillis()
                    writeMeta(etag.orEmpty(), lastSyncedMs)
                    return false
                }
                if (!response.isSuccessful) {
                    Timber.tag(TAG).w("Remote stream-client fetch HTTP ${response.code} — keeping previous table")
                    return false
                }

                val body = response.body?.string()
                if (body.isNullOrEmpty()) {
                    Timber.tag(TAG).w("Remote stream-client fetch returned empty body — keeping previous table")
                    return false
                }

                val remote = when (val result = StreamClientParser.parse(body)) {
                    is StreamClientParser.ParseResult.Failure -> {
                        Timber.tag(TAG).w("Remote stream clients rejected: ${result.reason} — keeping previous table")
                        return false
                    }
                    is StreamClientParser.ParseResult.Success -> {
                        if (result.skippedEntries.isNotEmpty()) {
                            Timber.tag(TAG).w("Remote stream clients: skipped entries ${result.skippedEntries}")
                        }
                        result.config
                    }
                }

                return applyRemote(remote, body, response.header("ETag").orEmpty())
            }
        } catch (e: Exception) {
            Timber.tag(TAG).w(e, "Remote stream-client fetch failed: ${e.message} — keeping previous table")
            return false
        }
    }

    /**
     * Applies a validated remote table to memory FIRST, then best-effort persists the raw body +
     * meta — a disk failure must never discard an in-hand fix (losing the cache only costs a
     * refetch next start; losing the memory update costs working playback now).
     */
    internal fun applyRemote(
        remote: StreamClientParser.StreamClientConfig,
        body: String,
        etag: String,
    ): Boolean {
        val changed = remote != activeConfig
        activeConfig = remote
        if (changed) configEpoch++
        // Memory first, disk best-effort: a sync HAPPENED, so stamp it even if the cache write
        // below throws (full disk) — otherwise the UI would report "never synced" right after a
        // fetch that just fixed playback.
        lastSyncedMs = System.currentTimeMillis()
        Timber.tag(TAG).d("Remote stream clients applied (${remote.clients.size} entries, changed=$changed, epoch=$configEpoch)")

        try {
            cacheFile()?.let { PlayerConfigStore.writeAtomic(it, body) }
            writeMeta(etag, lastSyncedMs)
        } catch (e: Exception) {
            Timber.tag(TAG).w(e, "Could not persist remote stream clients (kept in memory): ${e.message}")
        }
        return changed
    }

    private fun parseSource(label: String, read: () -> String?): StreamClientParser.StreamClientConfig? {
        val text = try {
            read() ?: return null
        } catch (e: Exception) {
            Timber.tag(TAG).w(e, "Could not read $label: ${e.message}")
            return null
        }
        return when (val result = StreamClientParser.parse(text)) {
            is StreamClientParser.ParseResult.Failure -> {
                Timber.tag(TAG).w("Rejected $label: ${result.reason}")
                null
            }
            is StreamClientParser.ParseResult.Success -> {
                if (result.skippedEntries.isNotEmpty()) {
                    Timber.tag(TAG).w("$label: skipped entries ${result.skippedEntries}")
                }
                result.config
            }
        }
    }

    private fun loadBundledJson(context: Context): String? =
        context.assets.open(ASSET_NAME).bufferedReader().use { it.readText() }

    private fun cacheDir(): File? {
        cacheDirForTest?.let { return it.apply { if (!exists()) mkdirs() } }
        val context = appContext ?: return null
        return File(context.filesDir, "cipher_cache").apply { if (!exists()) mkdirs() }
    }

    private fun cacheFile(): File? = cacheDir()?.let { File(it, CACHE_FILE) }

    private fun metaFile(): File? = cacheDir()?.let { File(it, META_FILE) }

    /** Meta file: line 1 = ETag (may be empty), line 2 = lastFetchMs. */
    private fun readMeta(): Pair<String, Long>? {
        return try {
            val file = metaFile()?.takeIf { it.exists() } ?: return null
            val lines = file.readText().split("\n")
            if (lines.size < 2) return null
            val lastFetchMs = lines[1].toLongOrNull() ?: return null
            lines[0] to lastFetchMs
        } catch (e: Exception) {
            null
        }
    }

    private fun writeMeta(etag: String, lastFetchMs: Long) {
        try {
            metaFile()?.let { PlayerConfigStore.writeAtomic(it, "$etag\n$lastFetchMs") }
        } catch (e: Exception) {
            Timber.tag(TAG).w(e, "Could not write stream-client meta: ${e.message}")
        }
    }
}
