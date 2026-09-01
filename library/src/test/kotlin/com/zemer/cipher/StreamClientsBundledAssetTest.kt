package com.zemer.cipher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Guards the real bundled stream-client asset: it must always parse cleanly with zero skipped
 * entries — this same file is what devices fetch remotely from master, so a defect here is a
 * fleet-wide defect the moment it is pushed.
 */
class StreamClientsBundledAssetTest {

    private fun assetFile(): File {
        val candidates = listOf(
            File("src/main/assets/stream_clients.json"),
            File("library/src/main/assets/stream_clients.json"),
        )
        return candidates.firstOrNull { it.exists() }
            ?: error("stream_clients.json not found from ${File(".").absolutePath}")
    }

    private fun parsed(): StreamClientParser.ParseResult.Success {
        val result = StreamClientParser.parse(assetFile().readText())
        assertTrue("bundled asset must parse: $result", result is StreamClientParser.ParseResult.Success)
        return result as StreamClientParser.ParseResult.Success
    }

    @Test
    fun `bundled asset parses with zero skipped entries`() {
        assertTrue(parsed().skippedEntries.isEmpty())
    }

    @Test
    fun `bundled chain matches the shipped compiled order`() {
        // Entry 0 = main. This pins the chain the 2026-08-15 validation pass settled on (minus
        // the ANDROID_VR 1.65.10 and MWEB removals that followed - both proven dead on the CDN); a
        // reorder is a deliberate act that updates this test in the same commit.
        assertEquals(
            listOf("WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY"),
            parsed().config.clients.map { it.key },
        )
    }

    @Test
    fun `main client is the head-skip web client`() {
        val main = parsed().config.clients[0]
        assertEquals("WEB_REMIX", main.clientName)
        assertEquals(StreamClientParser.StreamClientDef.Protocol.WEB_CIPHER_POT, main.protocol)
        assertTrue(main.skipHeadValidation)
        assertTrue(main.loginSupported)
    }

    @Test
    fun `every client family has a display row`() {
        val config = parsed().config
        val families = config.clients.map { it.family }.toSet()
        for (family in families) {
            assertTrue("family $family missing from families[]", family in config.families)
        }
    }

    @Test
    fun `login-required entries are the authenticated cipher fallbacks`() {
        val byKey = parsed().config.clients.associateBy { it.key }
        assertTrue(byKey.getValue("WEB_CREATOR").loginRequired)
        assertTrue(byKey.getValue("VISIONOS").let { !it.loginRequired && !it.loginSupported })
    }
}
