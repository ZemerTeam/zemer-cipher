package com.zemer.cipher

import timber.log.Timber
import java.security.MessageDigest

object FunctionNameExtractor {
    private const val TAG = "Zemer_CipherFnExtract"

    data class SigFunctionInfo(
        val name: String,
        val constantArg: Int?,
        val constantArgs: List<Int>? = null,
        val preprocessFunc: String? = null,
        val preprocessArgs: List<Int>? = null,
        val isHardcoded: Boolean = false,
        // Full JS expression for VM-dispatch players where no named function can be extracted.
        // "INPUT" is replaced with the sig argument at export time.
        val jsExpression: String? = null
    )

    data class NFunctionInfo(
        val name: String,
        val arrayIndex: Int?,
        val constantArgs: List<Int>? = null,
        val isHardcoded: Boolean = false,
        // Full JS expression for the n-transform. "INPUT" is replaced with the n value.
        val jsExpression: String? = null
    )

    data class HardcodedPlayerConfig(
        val sigFuncName: String,
        val sigConstantArg: Int?,
        val sigConstantArgs: List<Int>? = null,
        val sigPreprocessFunc: String? = null,
        val sigPreprocessArgs: List<Int>? = null,
        val sigJsExpression: String? = null,
        val nFuncName: String,
        val nArrayIndex: Int?,
        val nConstantArgs: List<Int>?,
        val nJsExpression: String? = null,
        val signatureTimestamp: Int
    )

    private val KNOWN_PLAYER_CONFIGS = mapOf(
        "74edf1a3" to HardcodedPlayerConfig(
            sigFuncName = "JI",
            sigConstantArg = 48,
            sigConstantArgs = listOf(48, 1918),
            sigPreprocessFunc = "f1",
            sigPreprocessArgs = listOf(1, 6528),
            nFuncName = "GU",
            nArrayIndex = null,
            nConstantArgs = listOf(6, 6010),
            signatureTimestamp = 20522
        ),
        // player_ias 9c249f6f (2026-05-31): VM-dispatch via Tl/Oe/P_, no extractable function names.
        // Sig: bzn() calls Tl(48,5831,Oe(23,6943,s)); Oe(23,6943,s)=decodeURIComponent(s) which
        // CipherDeobfuscator already does, so WebView receives the decoded sig and calls Tl(48,5831,s).
        // N: g.W_(url,true).get("n") returns the VM-transformed n query param.
        // STS: extracted from player HTML as 20602.
        // Note: when no URL pattern matches inside the player JS, extractPlayerHash falls back to
        // MD5(first 10000 bytes). For 9c249f6f that MD5 is "a6fc27c5", so both keys are needed.
        "9c249f6f" to HardcodedPlayerConfig(
            sigFuncName = "_expr_sig",
            sigConstantArg = null,
            sigJsExpression = "Tl(48,5831,INPUT)",
            nFuncName = "_expr_n",
            nArrayIndex = null,
            nConstantArgs = null,
            nJsExpression = "(function(n){try{var u=new g.W_('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
            signatureTimestamp = 20602
        ),
        // MD5-fallback alias for the same player (no self-referencing URL inside the JS)
        "a6fc27c5" to HardcodedPlayerConfig(
            sigFuncName = "_expr_sig",
            sigConstantArg = null,
            sigJsExpression = "Tl(48,5831,INPUT)",
            nFuncName = "_expr_n",
            nArrayIndex = null,
            nConstantArgs = null,
            nJsExpression = "(function(n){try{var u=new g.W_('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
            signatureTimestamp = 20602
        ),
        // player_ias 4f38b487 (2026-06-03): Same VM-dispatch as 9c249f6f — new hash, same Tl/Oe/W_ layout.
        // Sig: Tl(48,5831,Oe(23,6943,q.s)); Oe decodes URI so WebView receives Tl(48,5831,sig).
        // N: g.W_ URL-param trick identical to 9c249f6f. STS unchanged at 20602.
        // Serves WEB, WEB_REMIX, and the player_ias fetched for TVHTML5 via iframe_api.
        "4f38b487" to HardcodedPlayerConfig(
            sigFuncName = "_expr_sig",
            sigConstantArg = null,
            sigJsExpression = "Tl(48,5831,INPUT)",
            nFuncName = "_expr_n",
            nArrayIndex = null,
            nConstantArgs = null,
            nJsExpression = "(function(n){try{var u=new g.W_('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
            signatureTimestamp = 20602
        ),
        // MD5-fallback alias for 4f38b487 (no self-referencing URL inside the JS)
        "1215646b" to HardcodedPlayerConfig(
            sigFuncName = "_expr_sig",
            sigConstantArg = null,
            sigJsExpression = "Tl(48,5831,INPUT)",
            nFuncName = "_expr_n",
            nArrayIndex = null,
            nConstantArgs = null,
            nJsExpression = "(function(n){try{var u=new g.W_('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
            signatureTimestamp = 20602
        ),
        // player_ias 5cabb421 (2026-06-03): TVHTML5 client, Q-array obfuscation, STS 20606.
        // Sig: Qp(25,37,Qp(51,3416,I.s)); Qp(51,...) is decodeURIComponent so WebView gets Qp(25,37,sig).
        // N: g.W1 URL-param trick (W1 is the URL parser class in this player).
        // Also served as player_ias when iframe_api occasionally routes to the TV player.
        "5cabb421" to HardcodedPlayerConfig(
            sigFuncName = "_expr_sig",
            sigConstantArg = null,
            sigJsExpression = "Qp(25,37,INPUT)",
            nFuncName = "_expr_n",
            nArrayIndex = null,
            nConstantArgs = null,
            nJsExpression = "(function(n){try{var u=new g.W1('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
            signatureTimestamp = 20606
        ),
        // MD5-fallback alias for 5cabb421
        "94f9ca52" to HardcodedPlayerConfig(
            sigFuncName = "_expr_sig",
            sigConstantArg = null,
            sigJsExpression = "Qp(25,37,INPUT)",
            nFuncName = "_expr_n",
            nArrayIndex = null,
            nConstantArgs = null,
            nJsExpression = "(function(n){try{var u=new g.W1('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
            signatureTimestamp = 20606
        ),
        // player_ias 9d2ef9ef (2026-06-08): VM-dispatch via v0/n7/uY. STS 20607.
        // Sig: yi(url,sp,s) calls v0(35,4499,n7(7,5748,s)); n7(7,5748,s)=decodeURIComponent(s)
        // (C>>2&11)==1 branch in n7 confirms it. CipherDeobfuscator already decodes so WebView gets v0(35,4499,sig).
        // N: g.uY URL-param trick (W_/W1/W2 have 0 occurrences; uY has 17).
        "9d2ef9ef" to HardcodedPlayerConfig(
            sigFuncName = "_expr_sig",
            sigConstantArg = null,
            sigJsExpression = "v0(35,4499,INPUT)",
            nFuncName = "_expr_n",
            nArrayIndex = null,
            nConstantArgs = null,
            nJsExpression = "(function(n){try{var u=new g.uY('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
            signatureTimestamp = 20607
        ),
        // MD5-fallback alias for 9d2ef9ef (no self-referencing URL inside the JS)
        "6fb43da5" to HardcodedPlayerConfig(
            sigFuncName = "_expr_sig",
            sigConstantArg = null,
            sigJsExpression = "v0(35,4499,INPUT)",
            nFuncName = "_expr_n",
            nArrayIndex = null,
            nConstantArgs = null,
            nJsExpression = "(function(n){try{var u=new g.uY('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
            signatureTimestamp = 20607
        ),
        // player_ias 69e2a55d (2026-06-08): VM-dispatch via Jf/C6/iE. STS 20611.
        // Sig: g2(url,sp,s) calls Jf(20,3699,C6(16,4986,s)); C6(16,4986,s)=decodeURIComponent(s)
        // (P<<2&7=0 falsy → || branch fires). CipherDeobfuscator already decodes so WebView gets Jf(20,3699,sig).
        // N: g.iE URL-param trick (W_/W1/W2 have 0 occurrences; iE confirmed in CVy n-transform function).
        "69e2a55d" to HardcodedPlayerConfig(
            sigFuncName = "_expr_sig",
            sigConstantArg = null,
            sigJsExpression = "Jf(20,3699,INPUT)",
            nFuncName = "_expr_n",
            nArrayIndex = null,
            nConstantArgs = null,
            nJsExpression = "(function(n){try{var u=new g.iE('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
            signatureTimestamp = 20611
        ),
        // MD5-fallback alias for 69e2a55d
        "70d8066f" to HardcodedPlayerConfig(
            sigFuncName = "_expr_sig",
            sigConstantArg = null,
            sigJsExpression = "Jf(20,3699,INPUT)",
            nFuncName = "_expr_n",
            nArrayIndex = null,
            nConstantArgs = null,
            nJsExpression = "(function(n){try{var u=new g.iE('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
            signatureTimestamp = 20611
        ),
        // player_ias 16ee6936 (2026-06-09): VM-dispatch via mP/Yx. STS 20613.
        // URL assembler: P=new g.Yx(P,!0);P.set("alr","yes");K&&(K=mP(4,155,<decode>(..,K)),...) — the
        // inner call is decodeURIComponent (CipherDeobfuscator already decodes), so WebView runs
        // mP(4,155,sig). N: g.Yx URL-param trick (same class CVy uses for .get("n")).
        // Empirically validated against the live CDN (tests/validate-player-config.mjs): a real
        // signatureCipher deciphered with mP(4,155,INPUT) + g.Yx returns HTTP 206; full WEB_REMIX
        // drain pinned to this player delivers whole songs. Served by iframe_api as an A/B variant
        // alongside 69e2a55d (not yet the sole live player when added).
        "16ee6936" to HardcodedPlayerConfig(
            sigFuncName = "_expr_sig",
            sigConstantArg = null,
            sigJsExpression = "mP(4,155,INPUT)",
            nFuncName = "_expr_n",
            nArrayIndex = null,
            nConstantArgs = null,
            nJsExpression = "(function(n){try{var u=new g.Yx('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
            signatureTimestamp = 20613
        ),
        // MD5-fallback alias for 16ee6936
        "ca366632" to HardcodedPlayerConfig(
            sigFuncName = "_expr_sig",
            sigConstantArg = null,
            sigJsExpression = "mP(4,155,INPUT)",
            nFuncName = "_expr_n",
            nArrayIndex = null,
            nConstantArgs = null,
            nJsExpression = "(function(n){try{var u=new g.Yx('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
            signatureTimestamp = 20613
        ),
        // player_ias ce74690f (2026-06-09): VM-dispatch via $9/cV. STS 20612.
        // URL assembler: f=new g.cV(f,!0);f.set("alr","yes");U&&(U=$9(2,6487,f3(4,1144,U)),...) — the
        // inner f3(4,1144,.) is decodeURIComponent (CipherDeobfuscator already decodes), so WebView
        // runs $9(2,6487,sig). N: g.cV URL-param trick (same class the .get("n") site constructs).
        // Empirically validated against the live CDN (tests/validate-player-config.mjs): a real
        // signatureCipher deciphered with $9(2,6487,INPUT) + g.cV returns HTTP 206, n-probe changed.
        // Served by iframe_api as an A/B variant alongside 69e2a55d when added.
        "ce74690f" to HardcodedPlayerConfig(
            sigFuncName = "_expr_sig",
            sigConstantArg = null,
            sigJsExpression = "\$9(2,6487,INPUT)",
            nFuncName = "_expr_n",
            nArrayIndex = null,
            nConstantArgs = null,
            nJsExpression = "(function(n){try{var u=new g.cV('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
            signatureTimestamp = 20612
        ),
        // MD5-fallback alias for ce74690f
        "a5669e32" to HardcodedPlayerConfig(
            sigFuncName = "_expr_sig",
            sigConstantArg = null,
            sigJsExpression = "\$9(2,6487,INPUT)",
            nFuncName = "_expr_n",
            nArrayIndex = null,
            nConstantArgs = null,
            nJsExpression = "(function(n){try{var u=new g.cV('https://x.googlevideo.com/videoplayback?n='+n,true);var t=u.get('n');return(t&&t!==n)?t:n;}catch(e){return n;}})(INPUT)",
            signatureTimestamp = 20612
        )
    )

    private val Q_ARRAY_PATTERN = Regex("""var\s+Q\s*=\s*"[^"]+"\s*\.\s*split\s*\(\s*"\}"\s*\)""")

    private val PLAYER_HASH_PATTERNS = listOf(
        Regex("""jsUrl['":\s]+[^"']*?/player/([a-f0-9]{8})/"""),
        Regex("""player_ias\.vflset/[^/]+/([a-f0-9]{8})/"""),
        Regex("""/s/player/([a-f0-9]{8})/""")
    )

    private val SIG_FUNCTION_PATTERNS = listOf(
        Regex("""&&\s*\(\s*[a-zA-Z0-9$]+\s*=\s*([a-zA-Z0-9$]+)\s*\(\s*(\d+)\s*,\s*decodeURIComponent\s*\(\s*[a-zA-Z0-9$]+\s*\)"""),
        Regex("""\b[cs]\s*&&\s*[adf]\.set\([^,]+\s*,\s*encodeURIComponent\(([a-zA-Z0-9$]+)\("""),
        Regex("""\b[a-zA-Z0-9]+\s*&&\s*[a-zA-Z0-9]+\.set\([^,]+\s*,\s*encodeURIComponent\(([a-zA-Z0-9$]+)\("""),
        Regex("""\bm=([a-zA-Z0-9${'$'}]{2,})\(decodeURIComponent\(h\.s\)\)"""),
        Regex("""\bc\s*&&\s*d\.set\([^,]+\s*,\s*(?:encodeURIComponent\s*\()([a-zA-Z0-9$]+)\("""),
        Regex("""\bc\s*&&\s*[a-z]\.set\([^,]+\s*,\s*encodeURIComponent\(([a-zA-Z0-9$]+)\("""),
    )

    private val N_FUNCTION_PATTERNS = listOf(
        Regex("""\.get\("n"\)\)&&\(b=([a-zA-Z0-9$]+)(?:\[(\d+)\])?\(([a-zA-Z0-9])\)"""),
        Regex("""\.get\("n"\)\)\s*&&\s*\(([a-zA-Z0-9$]+)\s*=\s*([a-zA-Z0-9$]+)(?:\[(\d+)\])?\(\1\)"""),
        Regex("""\(\s*([a-zA-Z0-9$]+)\s*=\s*String\.fromCharCode\(110\)"""),
        Regex("""([a-zA-Z0-9$]+)\s*=\s*function\([a-zA-Z0-9]\)\s*\{[^}]*?enhanced_except_"""),
    )

    fun hasQArrayObfuscation(playerJs: String): Boolean {
        val hasQArray = Q_ARRAY_PATTERN.containsMatchIn(playerJs)
        Timber.tag(TAG).d("Q-array obfuscation check: hasQArray=$hasQArray")

        if (hasQArray) {
            val match = Q_ARRAY_PATTERN.find(playerJs)
            if (match != null) {
                val start = match.range.first
                val qDefEnd = playerJs.indexOf(";", start)
                if (qDefEnd > start) {
                    val qDef = playerJs.substring(start, qDefEnd)
                    val elementCount = qDef.count { it == '}' } + 1
                    Timber.tag(TAG).d("Q-array detected with ~$elementCount elements")
                }
            }
        }
        return hasQArray
    }

    fun extractPlayerHash(playerJs: String): String? {
        Timber.tag(TAG).d("Extracting player hash from playerJs (${playerJs.length} chars)")

        for ((index, pattern) in PLAYER_HASH_PATTERNS.withIndex()) {
            val match = pattern.find(playerJs)
            if (match != null) {
                val hash = match.groupValues[1]
                Timber.tag(TAG).d("Player hash found via pattern $index: $hash")
                return hash
            }
        }

        val contentToHash = playerJs.take(10000)
        val md = MessageDigest.getInstance("MD5")
        val digest = md.digest(contentToHash.toByteArray())
        val computedHash = digest.take(4).joinToString("") { "%02x".format(it) }
        Timber.tag(TAG).d("Player hash computed from content: $computedHash")
        return computedHash
    }

    fun getHardcodedConfig(playerHash: String): HardcodedPlayerConfig? {
        val config = KNOWN_PLAYER_CONFIGS[playerHash]
        if (config != null) {
            Timber.tag(TAG).d("Found hardcoded config for hash $playerHash:")
            Timber.tag(TAG).d("  sigFunc=${config.sigFuncName}(${config.sigConstantArg}, ...)")
            Timber.tag(TAG).d("  nFunc=${config.nFuncName}[${config.nArrayIndex}]")
            Timber.tag(TAG).d("  signatureTimestamp=${config.signatureTimestamp}")
        } else {
            Timber.tag(TAG).w("No hardcoded config for hash: $playerHash")
            Timber.tag(TAG).w("Known hashes: ${KNOWN_PLAYER_CONFIGS.keys.joinToString()}")
        }
        return config
    }

    fun extractSigFunctionInfo(playerJs: String, knownHash: String? = null): SigFunctionInfo? {
        Timber.tag(TAG).d("========== EXTRACTING SIG FUNCTION ==========")
        Timber.tag(TAG).d("Player.js size: ${playerJs.length} chars")

        for ((index, pattern) in SIG_FUNCTION_PATTERNS.withIndex()) {
            Timber.tag(TAG).v("Trying sig pattern $index: ${pattern.pattern.take(60)}...")
            val match = pattern.find(playerJs)
            if (match != null) {
                val name = match.groupValues[1]
                val constArg = if (match.groupValues.size > 2) match.groupValues[2].toIntOrNull() else null
                Timber.tag(TAG).d("SIG FUNCTION FOUND via pattern $index:")
                Timber.tag(TAG).d("  name=$name, constantArg=$constArg")
                Timber.tag(TAG).d("  match context: ...${playerJs.substring(maxOf(0, match.range.first - 20), minOf(playerJs.length, match.range.last + 20))}...")
                return SigFunctionInfo(name, constArg, isHardcoded = false)
            }
        }

        Timber.tag(TAG).w("No sig pattern matched, trying hardcoded config (Q-array or expression-based)...")

        // Try hardcoded config even without Q-array (catches VM-dispatch players like 9c249f6f)
        val hashToUse = knownHash ?: extractPlayerHash(playerJs)
        Timber.tag(TAG).d("Using hash for hardcoded lookup: $hashToUse (knownHash=$knownHash)")
        if (hashToUse != null) {
            val config = getHardcodedConfig(hashToUse)
            if (config != null) {
                if (config.sigJsExpression != null) {
                    Timber.tag(TAG).d("USING EXPRESSION-BASED SIG: ${config.sigJsExpression}")
                    return SigFunctionInfo(
                        name = config.sigFuncName,
                        constantArg = null,
                        isHardcoded = true,
                        jsExpression = config.sigJsExpression
                    )
                }
                Timber.tag(TAG).d("USING HARDCODED SIG FUNCTION: ${config.sigFuncName}(${config.sigConstantArgs}, ...)")
                Timber.tag(TAG).d("Sig preprocess: ${config.sigPreprocessFunc}(${config.sigPreprocessArgs}, sig)")
                return SigFunctionInfo(
                    name = config.sigFuncName,
                    constantArg = config.sigConstantArg,
                    constantArgs = config.sigConstantArgs,
                    preprocessFunc = config.sigPreprocessFunc,
                    preprocessArgs = config.sigPreprocessArgs,
                    isHardcoded = true
                )
            }
        }

        Timber.tag(TAG).e("========== SIG FUNCTION EXTRACTION FAILED ==========")
        Timber.tag(TAG).e("Could not find signature deobfuscation function name")
        return null
    }

    fun extractNFunctionInfo(playerJs: String, knownHash: String? = null): NFunctionInfo? {
        Timber.tag(TAG).d("========== EXTRACTING N-FUNCTION ==========")
        Timber.tag(TAG).d("Player.js size: ${playerJs.length} chars")

        for ((index, pattern) in N_FUNCTION_PATTERNS.withIndex()) {
            Timber.tag(TAG).v("Trying n-func pattern $index: ${pattern.pattern.take(60)}...")
            val match = pattern.find(playerJs)
            if (match != null) {
                when (index) {
                    0 -> {
                        val name = match.groupValues[1]
                        val arrayIdx = match.groupValues[2].toIntOrNull()
                        Timber.tag(TAG).d("N-FUNCTION FOUND via pattern $index:")
                        Timber.tag(TAG).d("  name=$name, arrayIndex=$arrayIdx")
                        return NFunctionInfo(name, arrayIdx, isHardcoded = false)
                    }
                    1 -> {
                        val name = match.groupValues[2]
                        val arrayIdx = match.groupValues[3].toIntOrNull()
                        Timber.tag(TAG).d("N-FUNCTION FOUND via pattern $index:")
                        Timber.tag(TAG).d("  name=$name, arrayIndex=$arrayIdx")
                        return NFunctionInfo(name, arrayIdx, isHardcoded = false)
                    }
                    else -> {
                        val name = match.groupValues[1]
                        Timber.tag(TAG).d("N-FUNCTION FOUND via pattern $index:")
                        Timber.tag(TAG).d("  name=$name")
                        return NFunctionInfo(name, null, isHardcoded = false)
                    }
                }
            }
        }

        Timber.tag(TAG).w("No n-func pattern matched, trying hardcoded config...")

        // Try hardcoded config even without Q-array
        val hashToUseN = knownHash ?: extractPlayerHash(playerJs)
        Timber.tag(TAG).d("Using hash for hardcoded lookup: $hashToUseN (knownHash=$knownHash)")
        if (hashToUseN != null) {
            val config = getHardcodedConfig(hashToUseN)
            if (config != null) {
                if (config.nJsExpression != null) {
                    Timber.tag(TAG).d("USING EXPRESSION-BASED N-FUNCTION: ${config.nJsExpression.take(60)}")
                    return NFunctionInfo(
                        name = config.nFuncName,
                        arrayIndex = null,
                        isHardcoded = true,
                        jsExpression = config.nJsExpression
                    )
                }
                Timber.tag(TAG).d("USING HARDCODED N-FUNCTION: ${config.nFuncName}[${config.nArrayIndex}]")
                Timber.tag(TAG).d("N-function constant args: ${config.nConstantArgs}")
                return NFunctionInfo(config.nFuncName, config.nArrayIndex, config.nConstantArgs, isHardcoded = true)
            }
        }

        Timber.tag(TAG).e("========== N-FUNCTION EXTRACTION FAILED ==========")
        Timber.tag(TAG).e("Could not find n-transform function name")
        return null
    }

    fun extractSignatureTimestamp(playerJs: String): Int? {
        Timber.tag(TAG).d("Extracting signatureTimestamp...")

        val patterns = listOf(
            Regex("""signatureTimestamp['":\s]+(\d+)"""),
            Regex("""sts['":\s]+(\d+)"""),
            Regex(""""signatureTimestamp"\s*:\s*(\d+)""")
        )

        for ((index, pattern) in patterns.withIndex()) {
            val match = pattern.find(playerJs)
            if (match != null) {
                val sts = match.groupValues[1].toIntOrNull()
                if (sts != null) {
                    Timber.tag(TAG).d("signatureTimestamp found via pattern $index: $sts")
                    return sts
                }
            }
        }

        val playerHash = extractPlayerHash(playerJs)
        if (playerHash != null) {
            val config = getHardcodedConfig(playerHash)
            if (config != null) {
                Timber.tag(TAG).d("Using hardcoded signatureTimestamp: ${config.signatureTimestamp}")
                return config.signatureTimestamp
            }
        }

        Timber.tag(TAG).w("Could not extract signatureTimestamp")
        return null
    }

    fun analyzePlayerJs(playerJs: String, knownHash: String? = null): PlayerAnalysis {
        Timber.tag(TAG).d("=== PLAYER.JS CIPHER ANALYSIS ===")

        val playerHash = if (knownHash != null) {
            Timber.tag(TAG).d("Using known hash from PlayerJsFetcher: $knownHash")
            knownHash
        } else {
            extractPlayerHash(playerJs)
        }

        val hasQArray = hasQArrayObfuscation(playerJs)
        val sigInfo = extractSigFunctionInfo(playerJs, playerHash)
        val nFuncInfo = extractNFunctionInfo(playerJs, playerHash)
        val signatureTimestamp = extractSignatureTimestamp(playerJs)

        Timber.tag(TAG).d("=== ANALYSIS SUMMARY ===")
        Timber.tag(TAG).d("Player Hash:        ${playerHash ?: "unknown"}")
        Timber.tag(TAG).d("Q-Array Obfuscated: $hasQArray")
        Timber.tag(TAG).d("Sig Function:       ${sigInfo?.name ?: "NOT FOUND"} (hardcoded=${sigInfo?.isHardcoded})")
        Timber.tag(TAG).d("Sig Constant Arg:   ${sigInfo?.constantArg}")
        Timber.tag(TAG).d("N-Function:         ${nFuncInfo?.name ?: "NOT FOUND"} (hardcoded=${nFuncInfo?.isHardcoded})")
        Timber.tag(TAG).d("N-Array Index:      ${nFuncInfo?.arrayIndex}")
        Timber.tag(TAG).d("Signature TS:       $signatureTimestamp")

        return PlayerAnalysis(
            playerHash = playerHash,
            hasQArrayObfuscation = hasQArray,
            sigInfo = sigInfo,
            nFuncInfo = nFuncInfo,
            signatureTimestamp = signatureTimestamp
        )
    }

    data class PlayerAnalysis(
        val playerHash: String?,
        val hasQArrayObfuscation: Boolean,
        val sigInfo: SigFunctionInfo?,
        val nFuncInfo: NFunctionInfo?,
        val signatureTimestamp: Int?
    )
}
