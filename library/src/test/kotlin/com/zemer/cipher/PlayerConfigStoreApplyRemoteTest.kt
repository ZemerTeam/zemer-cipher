package com.zemer.cipher

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * A fetched-and-validated remote table must reach the in-memory map even when persisting
 * it to disk fails: losing the cache costs a refetch on the next start, losing the memory
 * update costs working playback at the exact moment of a player rotation.
 */
class PlayerConfigStoreApplyRemoteTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var cacheDir: File

    private val validJson = """
        {"schemaVersion":1,"players":{"abcd1234":{"sig":"mP(4,155,INPUT)","nClass":"Yx","sts":20613}}}
    """.trimIndent()

    private fun parseConfigs(): Map<String, FunctionNameExtractor.HardcodedPlayerConfig> =
        (PlayerConfigParser.parse(validJson) as PlayerConfigParser.ParseResult.Success).configs

    @Before
    fun setUp() {
        cacheDir = tmp.newFolder("cipher_cache")
        PlayerConfigStore.cacheDirForTest = cacheDir
    }

    @After
    fun tearDown() {
        cacheDir.setWritable(true)
        PlayerConfigStore.cacheDirForTest = null
        PlayerConfigStore.setTableForTest(emptyMap())
    }

    @Test
    fun `applies to memory and persists body when disk is healthy`() {
        val changed = PlayerConfigStore.applyRemote(parseConfigs(), validJson, "\"etag123\"")

        assertTrue(changed)
        assertNotNull(PlayerConfigStore.get("abcd1234"))
        assertEquals(validJson, File(cacheDir, "configs_remote.json").readText())
    }

    @Test
    fun `applies to memory even when the disk write fails`() {
        cacheDir.setWritable(false)

        val changed = PlayerConfigStore.applyRemote(parseConfigs(), validJson, "\"etag123\"")

        assertTrue("validated config must not be discarded on disk failure", changed)
        assertNotNull(PlayerConfigStore.get("abcd1234"))
    }
}
