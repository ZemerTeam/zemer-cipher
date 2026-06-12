package com.zemer.cipher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayerDatesStoreTest {

    @Test
    fun `parses a flat hash to date map`() {
        val map = PlayerDatesStore.parse(
            """{ "959dabb2": "2026-06-12", "445213fb": "2026-06-10" }""",
        )
        assertEquals("2026-06-12", map["959dabb2"])
        assertEquals("2026-06-10", map["445213fb"])
    }

    @Test
    fun `skips non-string values rather than failing the whole file`() {
        val map = PlayerDatesStore.parse(
            """{ "good": "2026-06-12", "bad": 20614, "alsobad": null, "obj": {} }""",
        )
        assertEquals("2026-06-12", map["good"])
        assertNull(map["bad"])
        assertNull(map["alsobad"])
        assertEquals(1, map.size)
    }

    @Test
    fun `malformed or non-object json yields an empty map, never throws`() {
        assertTrue(PlayerDatesStore.parse("not json at all").isEmpty())
        assertTrue(PlayerDatesStore.parse("[1,2,3]").isEmpty())
        assertTrue(PlayerDatesStore.parse("").isEmpty())
    }
}
