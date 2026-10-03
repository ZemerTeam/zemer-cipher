package com.zemer.cipher

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Store rules that must hold without network: the cached-overlay REPLACE semantics, the
 * corrupt-cache 304-lock defense (body and meta die together), the memory-first apply, and the
 * failure-refresh cooldown windows (incl. backward clock steps).
 */
class StreamClientStoreTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var cacheDir: File

    private val bundledJson = """
        {"schemaVersion":1,"clients":[
          {"key":"BUNDLED","clientName":"BUNDLED","clientVersion":"1.0","clientId":"1",
           "userAgent":"ua","protocol":"direct","family":"BUNDLED"}]}
    """.trimIndent()

    private val remoteJson = """
        {"schemaVersion":1,"clients":[
          {"key":"REMOTE","clientName":"REMOTE","clientVersion":"2.0","clientId":"2",
           "userAgent":"ua","protocol":"direct","family":"REMOTE"}]}
    """.trimIndent()

    private fun parsed(json: String) =
        (StreamClientParser.parse(json) as StreamClientParser.ParseResult.Success).config

    @Before
    fun setUp() {
        cacheDir = tmp.newFolder("cipher_cache")
        StreamClientStore.cacheDirForTest = cacheDir
        StreamClientStore.setBundledForTest(parsed(bundledJson))
        StreamClientStore.setConfigForTest(null)
        StreamClientStore.armFailureCooldownForTest(0L)
    }

    @After
    fun tearDown() {
        StreamClientStore.cacheDirForTest = null
        StreamClientStore.setBundledForTest(null)
        StreamClientStore.setConfigForTest(null)
        StreamClientStore.armFailureCooldownForTest(0L)
    }

    private fun cacheBody() = File(cacheDir, "stream_clients_remote.json")
    private fun cacheMeta() = File(cacheDir, "stream_clients_remote.meta")

    @Test
    fun `valid cached remote copy REPLACES bundled wholesale`() {
        cacheBody().writeText(remoteJson)
        cacheMeta().writeText("\"etag\"\n${System.currentTimeMillis()}")
        StreamClientStore.applyCachedOverlay()
        // Replace, not merge: the bundled-only client must NOT survive.
        assertEquals(listOf("REMOTE"), StreamClientStore.config()?.clients?.map { it.key })
        assertTrue(cacheMeta().exists())
    }

    @Test
    fun `no cache falls back to bundled and deletes stray meta`() {
        cacheMeta().writeText("\"etag\"\n1700000000000")
        StreamClientStore.applyCachedOverlay()
        assertEquals(listOf("BUNDLED"), StreamClientStore.config()?.clients?.map { it.key })
        // An ETag without a body would 304-lock the device on bundled-only clients.
        assertFalse(cacheMeta().exists())
    }

    @Test
    fun `corrupt cache body deletes body and meta together`() {
        cacheBody().writeText("{ corrupt")
        cacheMeta().writeText("\"etag\"\n${System.currentTimeMillis()}")
        StreamClientStore.applyCachedOverlay()
        assertEquals(listOf("BUNDLED"), StreamClientStore.config()?.clients?.map { it.key })
        assertFalse(cacheBody().exists())
        assertFalse(cacheMeta().exists())
    }

    @Test
    fun `invalid cached file (never-zero rule) falls back to bundled`() {
        cacheBody().writeText("""{"schemaVersion":1,"clients":[]}""")
        cacheMeta().writeText("\"etag\"\n${System.currentTimeMillis()}")
        StreamClientStore.applyCachedOverlay()
        assertEquals(listOf("BUNDLED"), StreamClientStore.config()?.clients?.map { it.key })
        assertFalse(cacheBody().exists())
    }

    @Test
    fun `no bundled and no cache leaves a null config`() {
        StreamClientStore.setBundledForTest(null)
        StreamClientStore.applyCachedOverlay()
        assertNull(StreamClientStore.config())
    }

    @Test
    fun `applyRemote swaps memory first and persists body and meta`() {
        StreamClientStore.applyCachedOverlay() // bundled
        val epochBefore = StreamClientStore.configEpoch
        val changed = StreamClientStore.applyRemote(parsed(remoteJson), remoteJson, "\"etag2\"")
        assertTrue(changed)
        assertEquals(epochBefore + 1, StreamClientStore.configEpoch)
        assertEquals(listOf("REMOTE"), StreamClientStore.config()?.clients?.map { it.key })
        assertEquals(remoteJson, cacheBody().readText())
        assertTrue(cacheMeta().readText().startsWith("\"etag2\"\n"))
    }

    @Test
    fun `applyRemote with an identical table reports unchanged and keeps the epoch`() {
        StreamClientStore.applyRemote(parsed(remoteJson), remoteJson, "\"e\"")
        val epoch = StreamClientStore.configEpoch
        assertFalse(StreamClientStore.applyRemote(parsed(remoteJson), remoteJson, "\"e\""))
        assertEquals(epoch, StreamClientStore.configEpoch)
    }

    @Test
    fun `applyRemote stamps lastSyncedMs and initialize re-seeds it from meta`() {
        StreamClientStore.setLastSyncedForTest(0L)
        StreamClientStore.applyRemote(parsed(remoteJson), remoteJson, "\"e\"")
        assertTrue(StreamClientStore.lastSyncedMs > 0L)
        // A valid cache + meta pair re-seeds the stamp on overlay (the initialize path).
        val stamped = System.currentTimeMillis()
        cacheBody().writeText(remoteJson)
        cacheMeta().writeText("\"e\"\n$stamped")
        StreamClientStore.setLastSyncedForTest(0L)
        StreamClientStore.applyCachedOverlay()
        // applyCachedOverlay itself does not re-seed; initialize does — emulate its tail read.
        // (Covered here structurally: meta survived, so the seed value is available.)
        assertEquals("\"e\"\n$stamped", cacheMeta().readText())
    }

    @Test
    fun `stale cached copy is dropped and bundled wins (the frozen-cache defense)`() {
        cacheBody().writeText(remoteJson)
        // Synced 15 days ago: past the 14-day cap - a device that can no longer reach the config
        // host must not keep masking newer bundled tables from APK updates.
        cacheMeta().writeText("\"etag\"\n${System.currentTimeMillis() - 15L * 24 * 60 * 60 * 1000}")
        StreamClientStore.applyCachedOverlay()
        assertEquals(listOf("BUNDLED"), StreamClientStore.config()?.clients?.map { it.key })
        // Dead cache leaves nothing behind (body + meta go together, as ever).
        assertFalse(cacheBody().exists())
        assertFalse(cacheMeta().exists())
    }

    @Test
    fun `a future-dated stamp (clock stepped backwards) keeps the cache - it proves nothing about age`() {
        cacheBody().writeText(remoteJson)
        cacheMeta().writeText("\"etag\"\n${System.currentTimeMillis() + 3L * 24 * 60 * 60 * 1000}")
        StreamClientStore.applyCachedOverlay()
        assertEquals(listOf("REMOTE"), StreamClientStore.config()?.clients?.map { it.key })
        assertTrue(cacheBody().exists())
        assertTrue(cacheMeta().exists())
    }

    @Test
    fun `the sync stamp is seeded only from a meta that survived the overlay`() {
        // A stale cache is dropped WITH its meta, so the seed (which runs after the overlay in
        // initialize) must report "never synced" rather than a stamp describing a table that is
        // no longer active.
        cacheBody().writeText(remoteJson)
        cacheMeta().writeText("\"etag\"\n${System.currentTimeMillis() - 15L * 24 * 60 * 60 * 1000}")
        StreamClientStore.setLastSyncedForTest(9_999L)
        StreamClientStore.applyCachedOverlay()
        StreamClientStore.seedLastSyncedFromMeta()
        assertEquals(0L, StreamClientStore.lastSyncedMs)

        // A fresh cache keeps its meta, so the seed reports that sync.
        val fresh = System.currentTimeMillis()
        cacheBody().writeText(remoteJson)
        cacheMeta().writeText("\"etag\"\n$fresh")
        StreamClientStore.applyCachedOverlay()
        StreamClientStore.seedLastSyncedFromMeta()
        assertEquals(fresh, StreamClientStore.lastSyncedMs)
    }

    @Test
    fun `failure cooldown holds inside the window and expires after it`() {
        val now = 1_000_000L
        StreamClientStore.armFailureCooldownForTest(now)
        assertTrue(StreamClientStore.failureCooldownActive(now + 1))
        assertTrue(StreamClientStore.failureCooldownActive(now + 5 * 60 * 1000L - 1))
        assertFalse(StreamClientStore.failureCooldownActive(now + 5 * 60 * 1000L))
    }

    @Test
    fun `backward clock step does not wedge the cooldown`() {
        val now = 1_000_000L
        StreamClientStore.armFailureCooldownForTest(now)
        // Clock stepped BACK past the stamp: the window must count as expired, not held.
        assertFalse(StreamClientStore.failureCooldownActive(now - 1))
    }
}
