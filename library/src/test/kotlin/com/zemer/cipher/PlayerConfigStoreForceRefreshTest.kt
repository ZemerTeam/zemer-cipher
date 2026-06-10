package com.zemer.cipher

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * forceRefresh's contract is "is the missing hash now in the table", not "did my own fetch
 * change the map": a caller that lost the race to a concurrent refresh (startup TTL or
 * another miss) must still be told to retry extraction, and must not burn a network fetch
 * or arm the cooldown when the config is already present.
 */
class PlayerConfigStoreForceRefreshTest {

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
    fun `returns true without fetching when the hash is already present`() = runBlocking {
        PlayerConfigStore.setTableForTest(mapOf("abcd1234" to config))

        // No context, no network mock: if this short-circuit didn't fire, the call would
        // attempt a real fetch and (in this JVM environment) report the hash missing.
        assertTrue(PlayerConfigStore.forceRefresh(missingHash = "abcd1234"))
    }

    @Test
    fun `repeated calls for a present hash keep succeeding (cooldown never armed)`() = runBlocking {
        PlayerConfigStore.setTableForTest(mapOf("abcd1234" to config))

        repeat(3) {
            assertTrue(PlayerConfigStore.forceRefresh(missingHash = "abcd1234"))
        }
    }
}
