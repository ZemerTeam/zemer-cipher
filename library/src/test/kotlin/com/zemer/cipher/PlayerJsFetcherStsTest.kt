package com.zemer.cipher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The per-track STS lookup must not re-read the multi-megabyte player JS: the remembered Int is served
 * straight from the small hash file's verdict, and only while that file still names the player it came from.
 */
class PlayerJsFetcherStsTest {
    private val ttl = 6 * 60 * 60 * 1000L

    @Test
    fun `fast path serves the remembered sts for the player the cache still holds`() {
        assertEquals(20686, PlayerJsFetcher.stsFastPath(20686, "39a85230", "39a85230"))
    }

    @Test
    fun `fast path refuses when the cached player rotated, expired, or nothing is remembered`() {
        assertNull(PlayerJsFetcher.stsFastPath(20686, "39a85230", "b45afdfa")) // cache holds a newer player
        assertNull(PlayerJsFetcher.stsFastPath(20686, "39a85230", null)) // cache expired or absent
        assertNull(PlayerJsFetcher.stsFastPath(null, "39a85230", "39a85230")) // never extracted
        assertNull(PlayerJsFetcher.stsFastPath(20686, null, "39a85230")) // extracted before hash tracking
    }

    @Test
    fun `hash entry parses a live entry and rejects malformed or stale ones`() {
        val now = 1_000_000_000L
        assertEquals("39a85230", PlayerJsFetcher.parseHashEntry("39a85230\n${now - 1000}", now, ttl))
        assertNull(PlayerJsFetcher.parseHashEntry("39a85230", now, ttl)) // no timestamp line
        assertNull(PlayerJsFetcher.parseHashEntry("\n${now - 1000}", now, ttl)) // blank hash
        assertNull(PlayerJsFetcher.parseHashEntry("39a85230\nnot-a-number", now, ttl))
        assertNull(PlayerJsFetcher.parseHashEntry("39a85230\n${now - ttl - 1}", now, ttl)) // past the TTL
        assertNull(PlayerJsFetcher.parseHashEntry("39a85230\n${now + ttl + 1}", now, ttl)) // clock stepped back
    }
}
