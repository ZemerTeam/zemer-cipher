package com.zemer.cipher

import org.junit.Assert.assertEquals
import org.junit.Test

class PlayerConfigMergeTest {

    private fun config(sts: Int) = FunctionNameExtractor.HardcodedPlayerConfig(
        sigFuncName = "_expr_sig",
        sigConstantArg = null,
        sigJsExpression = "mP(4,155,INPUT)",
        nFuncName = "_expr_n",
        nArrayIndex = null,
        nConstantArgs = null,
        nJsExpression = PlayerConfigParser.buildNJsExpression("Yx"),
        signatureTimestamp = sts,
    )

    @Test
    fun `remote wins on shared key, bundled-only survives, remote-only is added`() {
        val bundled = mapOf("aaaa1111" to config(100), "bbbb2222" to config(200))
        val remote = mapOf("aaaa1111" to config(101), "cccc3333" to config(300))

        val merged = PlayerConfigParser.merge(bundled, remote)

        assertEquals(setOf("aaaa1111", "bbbb2222", "cccc3333"), merged.keys)
        assertEquals(101, merged.getValue("aaaa1111").signatureTimestamp) // remote wins
        assertEquals(200, merged.getValue("bbbb2222").signatureTimestamp) // bundled-only survives
        assertEquals(300, merged.getValue("cccc3333").signatureTimestamp) // remote-only added
    }

    @Test
    fun `empty remote leaves bundled untouched`() {
        val bundled = mapOf("aaaa1111" to config(100))
        assertEquals(bundled, PlayerConfigParser.merge(bundled, emptyMap()))
    }
}
