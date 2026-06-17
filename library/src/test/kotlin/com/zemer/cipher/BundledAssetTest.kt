package com.zemer.cipher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject

/**
 * Guards the real bundled asset: it must always parse cleanly and carry the full live config
 * set — this file is also what the player-monitor greps and what devices fetch remotely, so
 * a regression here breaks rotation handling everywhere at once.
 */
class BundledAssetTest {

    // Gradle runs JVM unit tests with the module dir as the working dir; resolve defensively
    // in case a runner uses the repo root instead.
    private fun assetFile(): File {
        val candidates = listOf(
            File("src/main/assets/player_configs.json"),
            File("library/src/main/assets/player_configs.json"),
        )
        return candidates.firstOrNull { it.exists() }
            ?: error("player_configs.json not found from ${File(".").absolutePath}")
    }

    private val expectedStsByPrimary = mapOf(
        "9c249f6f" to 20602,
        "4f38b487" to 20602,
        "5cabb421" to 20606,
        "9d2ef9ef" to 20607,
        "69e2a55d" to 20611,
        "ce74690f" to 20612,
        "16ee6936" to 20613,
        "6b8eecd5" to 20613,
        "445213fb" to 20613,
        "a32660fc" to 20613,
        "959dabb2" to 20614,
        "bb52fe90" to 20615,
        "1acfe3aa" to 20616,
    )

    private val expectedAliasByPrimary = mapOf(
        "9c249f6f" to "a6fc27c5",
        "4f38b487" to "1215646b",
        "5cabb421" to "94f9ca52",
        "9d2ef9ef" to "6fb43da5",
        "69e2a55d" to "70d8066f",
        "ce74690f" to "a5669e32",
        "16ee6936" to "ca366632",
        "6b8eecd5" to "6ea478fa",
        "445213fb" to "d62bd338",
        "a32660fc" to "e786ad71",
        "959dabb2" to "79c1b58e",
        "bb52fe90" to "f6046ecd",
        "1acfe3aa" to "fbcdec38",
    )

    @Test
    fun `bundled asset parses with no skipped entries and the full live config set`() {
        val jsonText = assetFile().readText()
        val result = PlayerConfigParser.parse(jsonText)
        assertTrue("expected Success, got $result", result is PlayerConfigParser.ParseResult.Success)
        val success = result as PlayerConfigParser.ParseResult.Success

        assertTrue("no entry may be skipped: ${success.skippedEntries}", success.skippedEntries.isEmpty())

        // Derive the expected count from the file so this never goes stale as the rotation runbook
        // adds players: every primary hash plus each of its aliases becomes a config entry (a
        // duplicate key makes parse() fail, so in a Success every key is distinct).
        val players = Json.parseToJsonElement(jsonText).jsonObject.getValue("players").jsonObject
        val primaryCount = players.size
        val aliasCount = players.values.sumOf { (it.jsonObject["aliases"] as? JsonArray)?.size ?: 0 }
        assertEquals(
            "every primary ($primaryCount) + alias ($aliasCount) must become a config",
            primaryCount + aliasCount,
            success.configs.size,
        )

        for ((primary, sts) in expectedStsByPrimary) {
            val config = success.configs[primary] ?: error("missing config for $primary")
            assertEquals("sts for $primary", sts, config.signatureTimestamp)
            assertSame("alias must share the primary's config", config, success.configs[expectedAliasByPrimary.getValue(primary)])
        }

        // Retired pre-VM-dispatch player, dropped after live verification (never served anymore).
        assertFalse("74edf1a3 must stay dropped", "74edf1a3" in success.configs)
    }
}
