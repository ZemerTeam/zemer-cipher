package com.zemer.cipher

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A validated config must always win over the legacy heuristic regexes: the patterns are
 * unanchored and can false-match anywhere in the ~2 MB player JS, and a false positive
 * used to both shadow the validated config and suppress the unknown-player forced refresh
 * in CipherDeobfuscator.
 */
class FunctionNameExtractorPrecedenceTest {

    private val hash = "abcd1234"

    // Contains decoys that the legacy patterns match: sig pattern
    // `c&&d.set(...,encodeURIComponent(NAME(` and n pattern `(x=String.fromCharCode(110)`.
    private val playerJsWithDecoys = """
        var noise = 1;
        c&&d.set("alr",encodeURIComponent(ZZ(decodeURIComponent(c)));
        if(z)(x=String.fromCharCode(110),q=a.get(x));
    """.trimIndent()

    private val config = FunctionNameExtractor.HardcodedPlayerConfig(
        sigFuncName = "_expr_sig",
        sigConstantArg = null,
        sigJsExpression = "mP(4,155,INPUT)",
        nFuncName = "_expr_n",
        nArrayIndex = null,
        nConstantArgs = null,
        nJsExpression = "(function(n){return n})(INPUT)",
        signatureTimestamp = 20613
    )

    @After
    fun resetStore() {
        PlayerConfigStore.setTableForTest(emptyMap())
    }

    @Test
    fun `validated config wins over legacy sig pattern decoy`() {
        PlayerConfigStore.setTableForTest(mapOf(hash to config))

        val sigInfo = FunctionNameExtractor.extractSigFunctionInfo(playerJsWithDecoys, hash)

        assertTrue(sigInfo!!.isHardcoded)
        assertEquals("mP(4,155,INPUT)", sigInfo.jsExpression)
    }

    @Test
    fun `validated config wins over legacy n pattern decoy`() {
        PlayerConfigStore.setTableForTest(mapOf(hash to config))

        val nInfo = FunctionNameExtractor.extractNFunctionInfo(playerJsWithDecoys, hash)

        assertTrue(nInfo!!.isHardcoded)
        assertEquals("(function(n){return n})(INPUT)", nInfo.jsExpression)
    }

    @Test
    fun `unknown hash still falls back to legacy patterns`() {
        val sigInfo = FunctionNameExtractor.extractSigFunctionInfo(playerJsWithDecoys, "ffff0000")

        assertFalse(sigInfo!!.isHardcoded)
        assertEquals("ZZ", sigInfo.name)
    }

    @Test
    fun `unknown hash with no pattern match returns null`() {
        assertNull(FunctionNameExtractor.extractSigFunctionInfo("var clean = 1;", "ffff0000"))
        assertNull(FunctionNameExtractor.extractNFunctionInfo("var clean = 1;", "ffff0000"))
    }
}
