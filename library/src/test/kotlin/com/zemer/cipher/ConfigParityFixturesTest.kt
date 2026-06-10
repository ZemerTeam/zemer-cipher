package com.zemer.cipher

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Golden accept/reject fixtures shared with the harness loader (tests/player-configs.mjs
 * in zemer-app runs the SAME files): file-level verdicts must match between the two
 * readers or "the harness reads exactly what a device reads" silently breaks.
 *
 * Only FILE-level semantics belong here — entry-level handling intentionally differs
 * (the app skips a bad entry and keeps playing; the harness throws).
 */
class ConfigParityFixturesTest {

    private val dir = File("src/test/resources/config-parity")

    @Test
    fun `fixture directory exists with both verdict kinds`() {
        val names = dir.listFiles()?.map { it.name }.orEmpty()
        assertTrue("fixtures missing at ${dir.absolutePath}", names.isNotEmpty())
        assertTrue(names.any { it.startsWith("accept-") })
        assertTrue(names.any { it.startsWith("reject-") })
    }

    @Test
    fun `accept fixtures parse as Success`() {
        for (file in dir.listFiles().orEmpty().filter { it.name.startsWith("accept-") }) {
            val result = PlayerConfigParser.parse(file.readText())
            assertTrue("${file.name}: expected Success, got $result", result is PlayerConfigParser.ParseResult.Success)
        }
    }

    @Test
    fun `reject fixtures parse as Failure`() {
        for (file in dir.listFiles().orEmpty().filter { it.name.startsWith("reject-") }) {
            val result = PlayerConfigParser.parse(file.readText())
            assertTrue("${file.name}: expected Failure, got $result", result is PlayerConfigParser.ParseResult.Failure)
        }
    }
}
