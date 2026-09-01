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
    fun `bundled chain is the shipped compiled order, minus any benched entry`() {
        // Entry 0 = main. This pins the chain the 2026-08-15 validation pass settled on (minus
        // the ANDROID_VR 1.65.10 and MWEB removals that followed - both proven dead on the CDN).
        // A reorder or an addition is a deliberate act that updates this test in the same commit;
        // a BENCH (`enabled: false`, what the client-monitor workflow commits unattended when a
        // fallback stops draining whole songs) is not - so the LIVE chain must be this order with
        // entries removed, never reordered, and the main must survive.
        val canonical = listOf("WEB_REMIX", "VISIONOS", "VISIONOS_0_1", "WEB_CREATOR", "TVHTML5_SIMPLY")
        val live = parsed().config.clients.map { it.key }
        assertEquals("WEB_REMIX", live.first())
        assertEquals("live chain must be a subsequence of $canonical, got $live", live, canonical.filter { it in live })
        assertTrue("every live key must be canonical: $live", live.all { it in canonical })
    }

    @Test
    fun `SABR roster is the sabr-capable entries in table order`() {
        // The SABR resolvers offer exactly these, in this order (WEB_REMIX identifies itself as
        // Windows 10.0 in the SABR streamerContext, its /player context stays OS-less). Adding or
        // removing a `sabr` object is a deliberate roster change that updates this test.
        val sabrEntries = parsed().config.clients.filter { it.sabr != null }
        val sabr = sabrEntries.map { it.key }
        val canonical = listOf("WEB_REMIX", "VISIONOS", "TVHTML5_SIMPLY")
        assertEquals("SABR roster must be a subsequence of $canonical, got $sabr", sabr, canonical.filter { it in sabr })
        assertEquals("WEB_REMIX", sabr.first())
        assertEquals(
            StreamClientParser.StreamClientDef.SabrInfo(osName = "Windows", osVersion = "10.0"),
            sabrEntries.first { it.key == "WEB_REMIX" }.sabr,
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
