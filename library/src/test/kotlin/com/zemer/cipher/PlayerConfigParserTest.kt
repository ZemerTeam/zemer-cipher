package com.zemer.cipher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayerConfigParserTest {

    private fun file(players: String, schemaVersion: String = "1") =
        """{ "schemaVersion": $schemaVersion, "players": { $players } }"""

    private val validEntry =
        """"16ee6936": { "sig": "mP(4,155,INPUT)", "nClass": "Yx", "sts": 20613, "aliases": ["ca366632"] }"""

    private fun parseSuccess(json: String): PlayerConfigParser.ParseResult.Success {
        val result = PlayerConfigParser.parse(json)
        assertTrue("expected Success, got $result", result is PlayerConfigParser.ParseResult.Success)
        return result as PlayerConfigParser.ParseResult.Success
    }

    private fun assertFileRejected(json: String) {
        val result = PlayerConfigParser.parse(json)
        assertTrue("expected Failure, got $result", result is PlayerConfigParser.ParseResult.Failure)
    }

    /** Entry invalid → that entry skipped, valid sibling survives. */
    private fun assertEntrySkipped(badEntry: String, badKey: String) {
        val success = parseSuccess(file("$badEntry, $validEntry"))
        assertTrue("expected $badKey in skippedEntries", badKey in success.skippedEntries)
        assertNotNull("valid sibling must survive", success.configs["16ee6936"])
        assertEquals("only the valid entry (+ alias) should remain", setOf("16ee6936", "ca366632"), success.configs.keys)
    }

    @Test
    fun `valid entry parses into the expression-based config shape`() {
        val success = parseSuccess(file(validEntry))
        val config = success.configs.getValue("16ee6936")
        assertEquals("_expr_sig", config.sigFuncName)
        assertEquals("mP(4,155,INPUT)", config.sigJsExpression)
        assertEquals("_expr_n", config.nFuncName)
        assertEquals(PlayerConfigParser.buildNJsExpression("Yx"), config.nJsExpression)
        assertEquals(20613, config.signatureTimestamp)
        assertEquals(null, config.sigConstantArg)
        assertEquals(null, config.nArrayIndex)
        assertEquals(null, config.nConstantArgs)
        assertTrue(success.skippedEntries.isEmpty())
    }

    @Test
    fun `alias resolves to the same config instance as its primary hash`() {
        val success = parseSuccess(file(validEntry))
        assertSame(success.configs["16ee6936"], success.configs["ca366632"])
    }

    @Test
    fun `entry without aliases is valid`() {
        val success = parseSuccess(file(""""69e2a55d": { "sig": "Jf(20,3699,INPUT)", "nClass": "iE", "sts": 20611 }"""))
        assertEquals(setOf("69e2a55d"), success.configs.keys)
    }

    // --- sig validation: nothing that could smuggle JS past the call-expression shape ---

    @Test
    fun `sig with appended statement is rejected`() =
        assertEntrySkipped(""""aaaa1111": { "sig": "mP(4,155,INPUT);alert(1)", "nClass": "Yx", "sts": 1 }""", "aaaa1111")

    @Test
    fun `sig without INPUT placeholder is rejected`() =
        assertEntrySkipped(""""aaaa1111": { "sig": "mP(4,155,x)", "nClass": "Yx", "sts": 1 }""", "aaaa1111")

    @Test
    fun `sig with over-long function name is rejected`() =
        assertEntrySkipped(""""aaaa1111": { "sig": "verylongname(1,2,INPUT)", "nClass": "Yx", "sts": 1 }""", "aaaa1111")

    @Test
    fun `sig with a single int arg is rejected`() =
        assertEntrySkipped(""""aaaa1111": { "sig": "mP(4,INPUT)", "nClass": "Yx", "sts": 1 }""", "aaaa1111")

    @Test
    fun `sig with non-numeric args is rejected`() =
        assertEntrySkipped(""""aaaa1111": { "sig": "mP(a,b,INPUT)", "nClass": "Yx", "sts": 1 }""", "aaaa1111")

    @Test
    fun `sig missing entirely is rejected`() =
        assertEntrySkipped(""""aaaa1111": { "nClass": "Yx", "sts": 1 }""", "aaaa1111")

    // --- nClass validation: bare identifier only ---

    @Test
    fun `nClass with property access is rejected`() =
        assertEntrySkipped(""""aaaa1111": { "sig": "mP(4,155,INPUT)", "nClass": "Yx.proto", "sts": 1 }""", "aaaa1111")

    @Test
    fun `nClass with call parens is rejected`() =
        assertEntrySkipped(""""aaaa1111": { "sig": "mP(4,155,INPUT)", "nClass": "Yx()", "sts": 1 }""", "aaaa1111")

    @Test
    fun `empty nClass is rejected`() =
        assertEntrySkipped(""""aaaa1111": { "sig": "mP(4,155,INPUT)", "nClass": "", "sts": 1 }""", "aaaa1111")

    @Test
    fun `over-long nClass is rejected`() =
        assertEntrySkipped(""""aaaa1111": { "sig": "mP(4,155,INPUT)", "nClass": "abcdefghi", "sts": 1 }""", "aaaa1111")

    // --- hash / alias validation ---

    @Test
    fun `seven-hex key is rejected`() =
        assertEntrySkipped(""""aaaa111": { "sig": "mP(4,155,INPUT)", "nClass": "Yx", "sts": 1 }""", "aaaa111")

    @Test
    fun `uppercase hex key is rejected`() =
        assertEntrySkipped(""""AAAA1111": { "sig": "mP(4,155,INPUT)", "nClass": "Yx", "sts": 1 }""", "AAAA1111")

    @Test
    fun `bad alias rejects the whole entry`() =
        assertEntrySkipped(
            """"aaaa1111": { "sig": "mP(4,155,INPUT)", "nClass": "Yx", "sts": 1, "aliases": ["XYZ12345"] }""",
            "aaaa1111",
        )

    // --- sts validation ---

    @Test
    fun `zero sts is rejected`() =
        assertEntrySkipped(""""aaaa1111": { "sig": "mP(4,155,INPUT)", "nClass": "Yx", "sts": 0 }""", "aaaa1111")

    @Test
    fun `negative sts is rejected`() =
        assertEntrySkipped(""""aaaa1111": { "sig": "mP(4,155,INPUT)", "nClass": "Yx", "sts": -1 }""", "aaaa1111")

    @Test
    fun `string sts is rejected`() =
        assertEntrySkipped(""""aaaa1111": { "sig": "mP(4,155,INPUT)", "nClass": "Yx", "sts": "20613" }""", "aaaa1111")

    @Test
    fun `missing sts is rejected`() =
        assertEntrySkipped(""""aaaa1111": { "sig": "mP(4,155,INPUT)", "nClass": "Yx" }""", "aaaa1111")

    // --- forward compat within a supported schema version ---

    @Test
    fun `unknown extra fields are ignored`() {
        val success = parseSuccess(
            file(""""16ee6936": { "sig": "mP(4,155,INPUT)", "nClass": "Yx", "sts": 20613, "futureField": {"x": 1} }"""),
        )
        assertNotNull(success.configs["16ee6936"])
    }

    // --- file-level gating ---

    @Test
    fun `newer schemaVersion rejects the whole file`() = assertFileRejected(file(validEntry, schemaVersion = "2"))

    @Test
    fun `missing schemaVersion rejects the whole file`() =
        assertFileRejected("""{ "players": { $validEntry } }""")

    @Test
    fun `non-positive schemaVersion rejects the whole file`() = assertFileRejected(file(validEntry, schemaVersion = "0"))

    @Test
    fun `garbage input rejects the whole file`() = assertFileRejected("not json at all {{{")

    @Test
    fun `top-level array rejects the whole file`() = assertFileRejected("""[1, 2, 3]""")

    @Test
    fun `missing players object rejects the whole file`() = assertFileRejected("""{ "schemaVersion": 1 }""")
}
