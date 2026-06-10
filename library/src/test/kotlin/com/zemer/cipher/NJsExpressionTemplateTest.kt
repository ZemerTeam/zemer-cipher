package com.zemer.cipher

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The n-IIFE used to be hardcoded per entry in FunctionNameExtractor.KNOWN_PLAYER_CONFIGS;
 * it is now built from a template with only the URL-class name varying. These golden strings
 * are the nJsExpression literals copied verbatim from the pre-refactor Kotlin map — byte
 * equality here proves the refactor changed nothing the WebView evaluates.
 */
class NJsExpressionTemplateTest {

    private val golden = mapOf(
        // 9c249f6f / 4f38b487 generation
        "W_" to "(function(n){try{var u=new g.W_('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
        // 5cabb421 (TVHTML5)
        "W1" to "(function(n){try{var u=new g.W1('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
        // 9d2ef9ef
        "uY" to "(function(n){try{var u=new g.uY('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
        // 69e2a55d
        "iE" to "(function(n){try{var u=new g.iE('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
        // 16ee6936 / 6b8eecd5
        "Yx" to "(function(n){try{var u=new g.Yx('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
        // ce74690f
        "cV" to "(function(n){try{var u=new g.cV('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
    )

    @Test
    fun `template output is byte-equal to every pre-refactor hardcoded literal`() {
        for ((nClass, expected) in golden) {
            assertEquals("nClass=$nClass", expected, PlayerConfigParser.buildNJsExpression(nClass))
        }
    }
}
