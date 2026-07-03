package com.zemer.cipher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RendererRecoveryPolicyTest {

    private fun policy() = RendererRecoveryPolicy(maxConsecutiveFailures = 3, backoffMs = 60_000)

    @Test
    fun `allows attempts while under the failure threshold`() {
        val p = policy()
        assertTrue(p.shouldAttempt(0))
        p.onFailure(1_000)
        assertTrue(p.shouldAttempt(1_000))
        p.onFailure(2_000)
        assertTrue(p.shouldAttempt(2_000))
    }

    @Test
    fun `opens backoff window after max consecutive failures`() {
        val p = policy()
        p.onFailure(1_000)
        p.onFailure(2_000)
        p.onFailure(3_000)
        assertFalse(p.shouldAttempt(3_000))
        assertFalse(p.shouldAttempt(3_000 + 59_999))
    }

    @Test
    fun `window is half-open - allows one attempt after it expires`() {
        val p = policy()
        repeat(3) { p.onFailure(3_000) }
        assertTrue(p.shouldAttempt(3_000 + 60_000))
    }

    @Test
    fun `failure after expired window re-arms backoff immediately`() {
        val p = policy()
        repeat(3) { p.onFailure(0) }
        val retryAt = 60_000L
        assertTrue(p.shouldAttempt(retryAt))
        p.onFailure(retryAt)
        assertFalse(p.shouldAttempt(retryAt))
        assertFalse(p.shouldAttempt(retryAt + 59_999))
        assertTrue(p.shouldAttempt(retryAt + 60_000))
    }

    @Test
    fun `success fully resets the policy`() {
        val p = policy()
        repeat(3) { p.onFailure(0) }
        assertFalse(p.shouldAttempt(1))
        p.onSuccess()
        assertEquals(0, p.consecutiveFailures)
        assertTrue(p.shouldAttempt(1))
        // Threshold counts from scratch again after reset.
        p.onFailure(2)
        p.onFailure(3)
        assertTrue(p.shouldAttempt(3))
    }

    @Test
    fun `success before threshold keeps the policy open`() {
        val p = policy()
        p.onFailure(0)
        p.onFailure(1)
        p.onSuccess()
        p.onFailure(2)
        p.onFailure(3)
        assertTrue(p.shouldAttempt(3))
    }
}
