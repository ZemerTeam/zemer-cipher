package com.zemer.cipher

import android.content.Context
import java.net.Proxy

/**
 * Configuration and initialization for the Zemer Cipher library.
 */
object ZemerCipher {
    /**
     * Optional proxy for network requests.
     */
    var proxy: Proxy? = null

    /**
     * Enable verbose debug logging.
     */
    var debugLogging: Boolean = false

    /**
     * Initialize the cipher library with the application context.
     * Must be called before using any cipher or potoken functionality.
     */
    fun initialize(context: Context, proxy: Proxy? = null, debugLogging: Boolean = false) {
        CipherDeobfuscator.initialize(context)
        this.proxy = proxy
        this.debugLogging = debugLogging
        PlayerJsFetcher.proxy = proxy
        PlayerConfigStore.initialize(context)
        PlayerConfigStore.scheduleStartupRefresh()
    }
}
