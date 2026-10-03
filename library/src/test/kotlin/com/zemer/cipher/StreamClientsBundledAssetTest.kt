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
    fun `bundled asset skips nothing but its benched entries`() {
        // A BENCHED entry (`enabled: false`, what the client-monitor commits unattended when a
        // fallback stops draining whole songs) is a skip by design; anything else skipped is a
        // typo that would silently drop a client fleet-wide.
        val benched = Regex(""""key":\s*"([A-Z0-9_]+)"[^{}]*"enabled":\s*false""")
            .findAll(assetFile().readText()).map { it.groupValues[1] }.toList()
        assertEquals("skipped entries must be exactly the benched ones", benched, parsed().skippedEntries)
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
        // Entries CARRYING a sabr object (capability benched or not) are the canonical trio in
        // order; the LIVE roster is that minus any benched capability (`sabr.enabled: false`, the
        // client-monitor's SABR kill switch). WEB_REMIX keeps its Windows identity either way.
        val carrying = parsed().config.clients.filter { it.sabr != null }
        val canonical = listOf("WEB_REMIX", "VISIONOS", "TVHTML5_SIMPLY")
        assertEquals("sabr-carrying entries must be $canonical, got ${carrying.map { it.key }}", canonical, carrying.map { it.key })
        val live = carrying.filter { it.sabr!!.enabled }.map { it.key }
        assertEquals("live SABR roster must be a subsequence of $canonical, got $live", live, canonical.filter { it in live })
        assertEquals(
            StreamClientParser.StreamClientDef.SabrInfo(osName = "Windows", osVersion = "10.0"),
            carrying.first { it.key == "WEB_REMIX" }.sabr!!.copy(enabled = true),
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
        // Any of these may be BENCHED by the client-monitor (absent from the live chain); the flag
        // shape is asserted for whichever are live.
        val byKey = parsed().config.clients.associateBy { it.key }
        byKey["WEB_CREATOR"]?.let { assertTrue(it.loginRequired) }
        byKey["VISIONOS"]?.let { assertTrue(!it.loginRequired && !it.loginSupported) }
    }
}
