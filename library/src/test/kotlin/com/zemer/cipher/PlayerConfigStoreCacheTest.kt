package com.zemer.cipher

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * A corrupt or missing cached remote body must take its meta/ETag down with it: an ETag
 * that survives the body makes every conditional fetch answer 304 without a re-download,
 * permanently locking the device onto bundled-only configs.
 */
class PlayerConfigStoreCacheTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var cacheDir: File

    private val validJson = """
        {"schemaVersion":1,"players":{"abcd1234":{"sig":"mP(4,155,INPUT)","nClass":"Yx","sts":20613}}}
    """.trimIndent()

    @Before
    fun setUp() {
        cacheDir = tmp.newFolder("cipher_cache")
        PlayerConfigStore.cacheDirForTest = cacheDir
    }

    @After
    fun tearDown() {
        PlayerConfigStore.cacheDirForTest = null
        PlayerConfigStore.setTableForTest(emptyMap())
    }

    private fun cacheBody() = File(cacheDir, "configs_remote.json")
    private fun cacheMeta() = File(cacheDir, "configs_remote.meta")

    @Test
    fun `valid cached copy is overlaid and meta survives`() {
        cacheBody().writeText(validJson)
        cacheMeta().writeText("\"etag123\"\n1700000000000")

        PlayerConfigStore.applyCachedOverlay()

        assertNotNull(PlayerConfigStore.get("abcd1234"))
        assertTrue(cacheMeta().exists())
    }

    @Test
    fun `corrupt cached body purges the meta file too`() {
        cacheBody().writeText("{\"schemaVersion\":1,\"players\":{tru") // truncated mid-write
        cacheMeta().writeText("\"etag123\"\n1700000000000")

        PlayerConfigStore.applyCachedOverlay()

        assertNull(PlayerConfigStore.get("abcd1234"))
        assertFalse("stale ETag must not survive a rejected body", cacheMeta().exists())
        assertFalse(cacheBody().exists())
    }

    @Test
    fun `missing cached body purges an orphaned meta file`() {
        cacheMeta().writeText("\"etag123\"\n1700000000000")

        PlayerConfigStore.applyCachedOverlay()

        assertFalse(cacheMeta().exists())
    }

    @Test
    fun `writeAtomic leaves the final content and no temp file`() {
        val target = File(cacheDir, "configs_remote.json")

        PlayerConfigStore.writeAtomic(target, "first")
        PlayerConfigStore.writeAtomic(target, "second")

        assertEquals("second", target.readText())
        assertFalse(File(cacheDir, "configs_remote.json.tmp").exists())
    }
}
