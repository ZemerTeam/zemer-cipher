package com.zemer.cipher

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Golden accept/reject fixtures shared with the zemer-app harness loader (tests/
 * stream-clients.test.mjs runs the SAME files): file-level verdicts must match between the two
 * readers or "the harness reads exactly what a device reads" silently breaks.
 *
 * Only FILE-level semantics belong here — entry-level handling intentionally differs
 * (the app skips a bad entry and keeps playing; the harness throws).
 */
class StreamClientsParityFixturesTest {

    private fun dir(): File {
        val candidates = listOf(
            File("src/test/resources/stream-clients-parity"),
            File("library/src/test/resources/stream-clients-parity"),
        )
        return candidates.firstOrNull { it.exists() }
            ?: error("stream-clients-parity fixtures not found from ${File(".").absolutePath}")
    }

    @Test
    fun `fixture directory exists with both verdict kinds`() {
        val names = dir().listFiles()?.map { it.name }.orEmpty()
        assertTrue("fixtures missing at ${dir().absolutePath}", names.isNotEmpty())
        assertTrue(names.any { it.startsWith("accept-") })
        assertTrue(names.any { it.startsWith("reject-") })
    }

    @Test
    fun `accept fixtures parse as Success`() {
        for (file in dir().listFiles().orEmpty().filter { it.name.startsWith("accept-") && !it.name.endsWith(".expect.json") }) {
            val result = StreamClientParser.parse(file.readText())
            assertTrue("${file.name}: expected Success, got $result", result is StreamClientParser.ParseResult.Success)
        }
    }

    @Test
    fun `accept fixtures yield the pinned live chain and skips (entry-level parity)`() {
        // <name>.expect.json pins WHICH entries survive and which are skipped, in order — the
        // harness loader checks the same sidecars, so the two readers agree on more than the verdict.
        for (file in dir().listFiles().orEmpty().filter { it.name.startsWith("accept-") && !it.name.endsWith(".expect.json") }) {
            val expect = File(file.parentFile, file.name.removeSuffix(".json") + ".expect.json")
            if (!expect.exists()) continue
            val json = kotlinx.serialization.json.Json.parseToJsonElement(expect.readText()) as kotlinx.serialization.json.JsonObject
            val keys = { name: String -> (json[name] as kotlinx.serialization.json.JsonArray).map { (it as kotlinx.serialization.json.JsonPrimitive).content } }
            val result = StreamClientParser.parse(file.readText()) as StreamClientParser.ParseResult.Success
            org.junit.Assert.assertEquals("${file.name} live chain", keys("clients"), result.config.clients.map { it.key })
            org.junit.Assert.assertEquals("${file.name} skipped", keys("skipped"), result.skippedEntries)
        }
    }

    @Test
    fun `reject fixtures parse as Failure`() {
        for (file in dir().listFiles().orEmpty().filter { it.name.startsWith("reject-") }) {
            val result = StreamClientParser.parse(file.readText())
            assertTrue("${file.name}: expected Failure, got $result", result is StreamClientParser.ParseResult.Failure)
        }
    }
}
