package com.zemer.cipher

import com.zemer.cipher.StreamClientParser.ParseResult
import com.zemer.cipher.StreamClientParser.StreamClientDef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamClientParserTest {

    private fun entry(
        key: String = "WEB_REMIX",
        clientName: String = "WEB_REMIX",
        protocol: String = "web_cipher_pot",
        extra: String = "",
    ) = """
        {
          "key": "$key",
          "clientName": "$clientName",
          "clientVersion": "1.20260213.01.00",
          "clientId": "67",
          "userAgent": "Mozilla/5.0 (test)",
          "protocol": "$protocol",
          "family": "$key"$extra
        }
    """.trimIndent()

    private fun file(vararg entries: String, schemaVersion: String = "1", families: String? = null) = """
        {
          "schemaVersion": $schemaVersion,
          "clients": [${entries.joinToString(",")}]
          ${families?.let { ", \"families\": $it" } ?: ""}
        }
    """.trimIndent()

    private fun success(json: String): StreamClientParser.StreamClientConfig {
        val result = StreamClientParser.parse(json)
        assertTrue("expected Success, got $result", result is ParseResult.Success)
        return (result as ParseResult.Success).config
    }

    private fun failure(json: String): String {
        val result = StreamClientParser.parse(json)
        assertTrue("expected Failure, got $result", result is ParseResult.Failure)
        return (result as ParseResult.Failure).reason
    }

    // --- happy path ---

    @Test
    fun `valid file parses in order with defaults`() {
        val config = success(file(entry("WEB_REMIX"), entry("VISIONOS_1", "VISIONOS", "direct")))
        assertEquals(listOf("WEB_REMIX", "VISIONOS_1"), config.clients.map { it.key })
        val main = config.clients[0]
        assertEquals(StreamClientDef.Protocol.WEB_CIPHER_POT, main.protocol)
        // Absent booleans default false; absent optionals default null.
        assertTrue(!main.loginSupported && !main.loginRequired && !main.isEmbedded && !main.skipHeadValidation)
        assertNull(main.osName)
    }

    @Test
    fun `flags and optional device fields parse`() {
        val config = success(
            file(
                entry(extra = """, "loginSupported": true, "skipHeadValidation": true"""),
                entry(
                    "ANDROID_VR", "ANDROID_VR", "direct",
                    extra = """, "osName": "Android", "osVersion": "12L", "deviceMake": "Oculus", "deviceModel": "Quest 3", "androidSdkVersion": "32""""
                ),
            )
        )
        assertTrue(config.clients[0].loginSupported)
        assertTrue(config.clients[0].skipHeadValidation)
        assertEquals("Oculus", config.clients[1].deviceMake)
        assertEquals("32", config.clients[1].androidSdkVersion)
    }

    @Test
    fun `families parse with duplicate id keeping the first row and bad rows skipped`() {
        val config = success(
            file(
                entry(),
                families = """[
                    {"id": "WEB_REMIX", "title": "First", "group": "web"},
                    {"id": "WEB_REMIX", "title": "Second", "group": "web"},
                    {"id": "bad id!", "title": "X", "group": "web"},
                    {"id": "VISIONOS", "title": "visionOS", "group": "UPPER_INVALID"}
                ]"""
            )
        )
        assertEquals(1, config.families.size)
        assertEquals("First", config.families["WEB_REMIX"]?.title)
    }

    @Test
    fun `missing families is fine`() {
        assertTrue(success(file(entry())).families.isEmpty())
    }

    // --- file-level rejects ---

    @Test
    fun `malformed json and wrong root reject`() {
        failure("not json {")
        failure("[]")
    }

    @Test
    fun `schemaVersion rules reject`() {
        failure(file(entry(), schemaVersion = "\"1\""))   // string-typed
        failure(file(entry(), schemaVersion = "0"))
        failure(file(entry(), schemaVersion = "2"))       // future
        failure("""{"clients": [${entry()}]}""")           // missing
    }

    @Test
    fun `missing or non-array clients rejects`() {
        failure("""{"schemaVersion": 1}""")
        failure("""{"schemaVersion": 1, "clients": {}}""")
    }

    @Test
    fun `duplicate key rejects`() {
        assertTrue(failure(file(entry("WEB_REMIX"), entry("WEB_REMIX"))).contains("duplicate"))
    }

    @Test
    fun `invalid main entry rejects wholesale`() {
        // Entry 0 unusable must not silently promote entry 1.
        assertTrue(failure(file(entry(protocol = "sabr"), entry("OK", "OK", "direct"))).contains("main"))
        failure(file(entry(extra = """, "enabled": false"""), entry("OK", "OK", "direct")))
    }

    @Test
    fun `zero usable entries rejects`() {
        failure("""{"schemaVersion": 1, "clients": []}""")
    }

    // --- per-entry skips ---

    @Test
    fun `unknown protocol on a non-main entry is skipped and reported`() {
        val result = StreamClientParser.parse(file(entry(), entry("FUTURE", "FUTURE", "sabr")))
            as ParseResult.Success
        assertEquals(listOf("WEB_REMIX"), result.config.clients.map { it.key })
        assertEquals(listOf("FUTURE"), result.skippedEntries)
    }

    @Test
    fun `kill switch enabled false skips the entry`() {
        val result = StreamClientParser.parse(
            file(entry(), entry("BENCHED", "BENCHED", "direct", extra = """, "enabled": false"""))
        ) as ParseResult.Success
        assertEquals(listOf("WEB_REMIX"), result.config.clients.map { it.key })
        assertEquals(listOf("BENCHED"), result.skippedEntries)
    }

    @Test
    fun `enabled true and absent both keep the entry, non-boolean skips`() {
        val config = success(file(entry(), entry("ON", "ON", "direct", extra = """, "enabled": true""")))
        assertEquals(2, config.clients.size)
        val result = StreamClientParser.parse(
            file(entry(), entry("BAD", "BAD", "direct", extra = """, "enabled": "false""""))
        ) as ParseResult.Success
        assertEquals(listOf("BAD"), result.skippedEntries)
    }

    @Test
    fun `explicit JSON null means absent, matching the harness loader`() {
        // kotlinx returns JsonNull (not null) for an explicit null, so without the JsonNull check
        // these entries would be SKIPPED on devices while the pre-push gate accepted the file —
        // a silent device/harness divergence that would ship a table devices refuse.
        val config = success(
            file(
                entry(extra = """, "osName": null, "deviceMake": null, "loginSupported": null"""),
                entry("SECOND", "SECOND", "direct", extra = """, "androidSdkVersion": null, "enabled": null"""),
            )
        )
        assertEquals(listOf("WEB_REMIX", "SECOND"), config.clients.map { it.key })
        assertNull(config.clients[0].osName)
        assertNull(config.clients[0].deviceMake)
        assertTrue(!config.clients[0].loginSupported)
        assertNull(config.clients[1].androidSdkVersion)
    }

    @Test
    fun `a chain longer than MAX_CLIENTS rejects the file`() {
        val many = (0..StreamClientParser.MAX_CLIENTS)
            .map { entry("K" + it, "K" + it, "direct") }
            .toTypedArray()
        assertTrue(failure(file(*many)).contains("too many"))
        // Exactly at the cap is fine.
        val atCap = (1..StreamClientParser.MAX_CLIENTS)
            .map { entry("K" + it, "K" + it, "direct") }
            .toTypedArray()
        assertEquals(StreamClientParser.MAX_CLIENTS, success(file(*atCap)).clients.size)
    }

    @Test
    fun `header-unsafe and malformed fields skip the entry`() {
        val cases = listOf(
            // CR/LF in the UA (header injection).
            entry("E1", "E1", "direct").replace("Mozilla/5.0 (test)", "Mozilla\\r\\nX-Evil: 1"),
            // Bad clientId (non-digits).
            entry("E2", "E2", "direct").replace("\"clientId\": \"67\"", "\"clientId\": \"67x\""),
            // Bad clientName shape.
            entry("E3", "lower case", "direct"),
            // Missing required field (userAgent).
            entry("E4", "E4", "direct").replace(Regex("\"userAgent\": \"[^\"]*\",\n\\s*"), ""),
            // Non-boolean flag.
            entry("E5", "E5", "direct", extra = """, "loginSupported": "yes""""),
            // Present-but-invalid optional field.
            entry("E6", "E6", "direct", extra = """, "osVersion": "bad version with spaces""""),
        )
        for (bad in cases) {
            val result = StreamClientParser.parse(file(entry(), bad)) as ParseResult.Success
            assertEquals("entry should be skipped: $bad", 1, result.config.clients.size)
            assertEquals(1, result.skippedEntries.size)
        }
    }

    @Test
    fun `userAgent over length cap skips`() {
        val longUa = "A".repeat(301)
        val result = StreamClientParser.parse(
            file(entry(), entry("E7", "E7", "direct").replace("Mozilla/5.0 (test)", longUa))
        ) as ParseResult.Success
        assertEquals(1, result.config.clients.size)
    }

    @Test
    fun `sabr absent or null means not SABR-usable`() {
        assertNull(success(file(entry())).clients[0].sabr)
        assertNull(success(file(entry(extra = """, "sabr": null"""))).clients[0].sabr)
    }

    @Test
    fun `sabr object marks the entry SABR-usable with optional identity overrides`() {
        val empty = success(file(entry(extra = """, "sabr": {}"""))).clients[0].sabr
        assertEquals(StreamClientDef.SabrInfo(), empty)
        val overridden = success(
            file(entry(extra = """, "sabr": {"osName": "Windows", "osVersion": "10.0", "deviceMake": null}""")),
        ).clients[0].sabr
        assertEquals(StreamClientDef.SabrInfo(osName = "Windows", osVersion = "10.0"), overridden)
    }

    @Test
    fun `a malformed sabr field skips the entry - or rejects the file when it is the main row`() {
        for (bad in listOf("true", "\"yes\"", "[]", """{"osName": 1}""", """{"osVersion": "bad version!"}""")) {
            val result = StreamClientParser.parse(file(entry(), entry(key = "B", extra = """, "sabr": $bad""")))
            assertTrue("sabr=$bad must skip B, got $result", result is ParseResult.Success)
            assertEquals("sabr=$bad", listOf("B"), (result as ParseResult.Success).skippedEntries)
            failure(file(entry(extra = """, "sabr": $bad""")))
        }
    }
}
