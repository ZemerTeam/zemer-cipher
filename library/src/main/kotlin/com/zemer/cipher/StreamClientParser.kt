package com.zemer.cipher

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray

/**
 * Parses and validates the stream-client table JSON (`stream_clients.json`, bundled asset and
 * remote copies) — the remote registry of YouTube clients the app's stream resolution may use,
 * their fallback ORDER (entry 0 is the main client), per-client behavior flags, and which entries
 * the SABR transport may use (the `sabr` object — the SABR roster is table data too).
 *
 * Pure JVM on purpose (no Android/Timber imports), like [PlayerConfigParser]: the full validation
 * surface is coverable by plain unit tests, and the same accept/reject verdicts are pinned by the
 * shared fixtures in `src/test/resources/stream-clients-parity/` which the zemer-app Node harness
 * loader also runs.
 *
 * Security boundary — DATA not CODE: nothing in this file is ever evaluated as code. Every value
 * becomes a JSON body field or HTTP header VALUE on requests to the hardcoded music.youtube.com
 * origin, so fields are locked to shapes that cannot carry header injection (printable ASCII, no
 * CR/LF) and behavior is selected ONLY via the closed [StreamClientDef.Protocol] enum — the config
 * can pick a compiled-in path, never define one. No URL, endpoint, header-map, or script field
 * exists in the schema.
 */
object StreamClientParser {
    const val SUPPORTED_SCHEMA_VERSION = 1

    /**
     * Upper bound on chain length. Every other value in the schema is bounded; this one's cost is
     * live NETWORK round-trips — the resolver issues one /player request per client before giving
     * up, so a runaway file (a generator loop, a duplicated block, a merge accident) would stall
     * playback for tens of seconds and hammer YouTube. Rejected file-level: a table this long is
     * never intentional.
     */
    const val MAX_CLIENTS = 32

    private val KEY_RE = Regex("""^[A-Z0-9_]{1,32}$""")
    private val CLIENT_ID_RE = Regex("""^[0-9]{1,4}$""")
    private val VERSIONISH_RE = Regex("""^[A-Za-z0-9._-]{1,32}$""")
    private val GROUP_RE = Regex("""^[a-z0-9_-]{1,16}$""")

    // Header-value guard: printable ASCII only (0x20–0x7E), so a value can never smuggle CR/LF
    // header injection or non-ASCII the CDN/API would choke on.
    private fun headerSafe(value: String, maxLen: Int): Boolean =
        value.isNotEmpty() && value.length <= maxLen && value.all { it.code in 0x20..0x7E }

    /** One client entry, in file order. Entry 0 of [StreamClientConfig.clients] is the main client. */
    data class StreamClientDef(
        val key: String,
        val clientName: String,
        val clientVersion: String,
        val clientId: String,
        val userAgent: String,
        val protocol: Protocol,
        val family: String,
        val osName: String? = null,
        val osVersion: String? = null,
        val deviceMake: String? = null,
        val deviceModel: String? = null,
        val androidSdkVersion: String? = null,
        val loginSupported: Boolean = false,
        val loginRequired: Boolean = false,
        val isEmbedded: Boolean = false,
        val skipHeadValidation: Boolean = false,
        /**
         * Present = this client is SABR-usable (validated to deliver a whole song over the
         * serverAbrStreamingUrl transport with the app's pot); absent = SABR never tries it. The
         * SABR roster is the table's sabr-capable entries in TABLE order, so it lives here rather
         * than in a compiled list. Its fields override the entry's own os/device identity for the
         * SABR streamerContext.clientInfo only (the `/player` context is untouched) — WEB_REMIX
         * announces "Windows 10.0" there while its `/player` request carries no OS.
         */
        val sabr: SabrInfo? = null,
    ) {
        /**
         * SABR clientInfo overrides; every field optional (null = inherit the entry's own).
         * [enabled] false = the SABR capability is BENCHED (the client-monitor's kill switch for the
         * SABR transport alone: the entry keeps streaming progressively and keeps its identity
         * overrides for the day SABR works again). Absent = enabled.
         */
        data class SabrInfo(
            val osName: String? = null,
            val osVersion: String? = null,
            val deviceMake: String? = null,
            val deviceModel: String? = null,
            val androidSdkVersion: String? = null,
            val enabled: Boolean = true,
        )

        /**
         * The closed set of compiled-in stream-handling paths. An entry naming a protocol slug
         * outside this set is SKIPPED (forward compat: a future file may carry clients for a
         * protocol this app version does not implement).
         */
        enum class Protocol(val slug: String) {
            /** Web path: cipher sig + n-transform + pot append + poToken/STS in the body. */
            WEB_CIPHER_POT("web_cipher_pot"),

            /** Direct-URL clients: the CDN URL is used AS-IS (transforms would corrupt it). */
            DIRECT("direct"),
            ;

            companion object {
                fun fromSlug(slug: String): Protocol? = entries.firstOrNull { it.slug == slug }
            }
        }
    }

    /** Display metadata for a toggle family (several entries may share one family). */
    data class FamilyMeta(val id: String, val title: String, val group: String)

    data class StreamClientConfig(
        /** Ordered: entry 0 is the main client, the rest the fallback chain. Never empty. */
        val clients: List<StreamClientDef>,
        val families: Map<String, FamilyMeta>,
    )

    sealed class ParseResult {
        data class Success(
            val config: StreamClientConfig,
            /** Entry keys (or "clients[i]" for key-less entries) skipped as invalid/disabled. */
            val skippedEntries: List<String>,
        ) : ParseResult()

        data class Failure(val reason: String) : ParseResult()
    }

    /**
     * Parses [jsonText]. File-level problems return [ParseResult.Failure] — callers keep their
     * previous table (never a partial/empty one):
     * - malformed JSON / wrong root shape
     * - schemaVersion missing, string-typed, non-positive, or newer than supported
     * - `clients` missing / not an array / no usable entries after skips (never-zero invariant)
     * - a duplicate entry `key`
     * - entry 0 (the MAIN client) invalid, disabled, or unknown-protocol — the file's most
     *   load-bearing row must be sound; a file that would silently promote a different main is
     *   refused wholesale
     *
     * Invalid individual NON-MAIN entries (bad shape, unknown protocol, `enabled: false`) are
     * skipped and reported via [ParseResult.Success.skippedEntries].
     */
    fun parse(jsonText: String): ParseResult {
        val root = try {
            Json.parseToJsonElement(jsonText) as? JsonObject
                ?: return ParseResult.Failure("root is not a JSON object")
        } catch (e: Exception) {
            return ParseResult.Failure("malformed JSON: ${e.message}")
        }

        // Non-string primitive only: a string-typed "1" must fail identically here and in the
        // harness loader, or the two readers drift on the same file (PlayerConfigParser parity).
        val schemaVersion = (root["schemaVersion"] as? JsonPrimitive)
            ?.takeIf { !it.isString }?.content?.toIntOrNull()
            ?: return ParseResult.Failure("schemaVersion missing or not an int")
        if (schemaVersion <= 0) return ParseResult.Failure("schemaVersion must be positive")
        if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
            return ParseResult.Failure("unsupported schemaVersion $schemaVersion (supported: $SUPPORTED_SCHEMA_VERSION)")
        }

        val clientsArray = try {
            root["clients"]?.jsonArray ?: return ParseResult.Failure("clients missing or not an array")
        } catch (e: Exception) {
            return ParseResult.Failure("clients missing or not an array")
        }

        val clients = mutableListOf<StreamClientDef>()
        val seenKeys = mutableSetOf<String>()
        val skipped = mutableListOf<String>()

        for ((index, element) in clientsArray.withIndex()) {
            val obj = element as? JsonObject
            val keyLabel = ((obj?.get("key") as? JsonPrimitive)?.takeIf { it.isString }?.content)
                ?: "clients[$index]"
            // A duplicate key is a file-level reject whether or not the rows are usable: a benched
            // twin of a live key would otherwise be accepted here but make the only writer
            // (apply-bench) unable to act on that key, and un-benching the twin by hand would turn
            // the file into a wholesale reject on every device.
            if (obj != null && KEY_RE.matches(keyLabel) && !seenKeys.add(keyLabel)) {
                return ParseResult.Failure("duplicate client key '$keyLabel'")
            }
            val entry = parseEntry(obj)
            if (entry == null) {
                // Entry 0 is the main client: a file whose main row is unusable is rejected
                // wholesale rather than silently promoting whatever comes next.
                if (index == 0) return ParseResult.Failure("main client entry (clients[0]) is invalid or disabled")
                skipped += keyLabel
                continue
            }
            clients += entry
        }

        if (clients.isEmpty()) {
            return ParseResult.Failure("no usable client entries (never-zero-clients invariant)")
        }
        if (clients.size > MAX_CLIENTS) {
            return ParseResult.Failure("too many client entries (${clients.size} > $MAX_CLIENTS)")
        }

        return ParseResult.Success(
            StreamClientConfig(clients = clients, families = parseFamilies(root)),
            skipped,
        )
    }

    /** Null = skip this entry (invalid shape, unknown protocol, or disabled via the kill switch). */
    private fun parseEntry(obj: JsonObject?): StreamClientDef? {
        if (obj == null) return null

        // The kill switch: a present-and-false `enabled` benches the entry while its row/notes
        // stay in the file. Anything but a strict boolean false (absent, true) keeps it live;
        // a non-boolean `enabled` is a malformed entry and skips too.
        when (val enabled = obj["enabled"]) {
            null, JsonNull -> Unit
            else -> {
                val prim = (enabled as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
                when (prim.content) {
                    "true" -> Unit
                    "false" -> return null
                    else -> return null
                }
            }
        }

        val key = string(obj, "key")?.takeIf { KEY_RE.matches(it) } ?: return null
        val clientName = string(obj, "clientName")?.takeIf { KEY_RE.matches(it) } ?: return null
        val clientVersion = string(obj, "clientVersion")?.takeIf { VERSIONISH_RE.matches(it) } ?: return null
        val clientId = string(obj, "clientId")?.takeIf { CLIENT_ID_RE.matches(it) } ?: return null
        val userAgent = string(obj, "userAgent")?.takeIf { headerSafe(it, 300) } ?: return null
        val protocolSlug = string(obj, "protocol") ?: return null
        val protocol = StreamClientDef.Protocol.fromSlug(protocolSlug) ?: return null
        val family = string(obj, "family")?.takeIf { KEY_RE.matches(it) } ?: return null

        val osName = optionalString(obj, "osName") { headerSafe(it, 64) } ?: return null
        val osVersion = optionalString(obj, "osVersion") { VERSIONISH_RE.matches(it) } ?: return null
        val deviceMake = optionalString(obj, "deviceMake") { headerSafe(it, 64) } ?: return null
        val deviceModel = optionalString(obj, "deviceModel") { headerSafe(it, 64) } ?: return null
        val androidSdkVersion = optionalString(obj, "androidSdkVersion") { VERSIONISH_RE.matches(it) } ?: return null

        val loginSupported = boolean(obj, "loginSupported") ?: return null
        val loginRequired = boolean(obj, "loginRequired") ?: return null
        val isEmbedded = boolean(obj, "isEmbedded") ?: return null
        val skipHeadValidation = boolean(obj, "skipHeadValidation") ?: return null
        val sabr = parseSabr(obj) ?: return null

        return StreamClientDef(
            key = key,
            clientName = clientName,
            clientVersion = clientVersion,
            clientId = clientId,
            userAgent = userAgent,
            protocol = protocol,
            family = family,
            osName = osName.value,
            osVersion = osVersion.value,
            deviceMake = deviceMake.value,
            deviceModel = deviceModel.value,
            androidSdkVersion = androidSdkVersion.value,
            loginSupported = loginSupported,
            loginRequired = loginRequired,
            isEmbedded = isEmbedded,
            skipHeadValidation = skipHeadValidation,
            sabr = sabr.value,
        )
    }

    /** Wrapper distinguishing "absent" (fine, null) from "present but invalid" (skip entry). */
    private class OptionalSabr(val value: StreamClientDef.SabrInfo?)

    /**
     * `sabr`: absent/null = not SABR-usable; an object (possibly empty) = SABR-usable, with the
     * same optional os/device fields (same shapes) as the entry itself. Anything else — a
     * boolean, a string, an array — is a malformed entry and skips it, so a typo can never
     * silently promote a client into (or out of) the SABR roster with an unintended identity.
     */
    private fun parseSabr(obj: JsonObject): OptionalSabr? {
        val element = obj["sabr"]
        if (element == null || element is JsonNull) return OptionalSabr(null)
        val sabrObj = element as? JsonObject ?: return null
        val osName = optionalString(sabrObj, "osName") { headerSafe(it, 64) } ?: return null
        val osVersion = optionalString(sabrObj, "osVersion") { VERSIONISH_RE.matches(it) } ?: return null
        val deviceMake = optionalString(sabrObj, "deviceMake") { headerSafe(it, 64) } ?: return null
        val deviceModel = optionalString(sabrObj, "deviceModel") { headerSafe(it, 64) } ?: return null
        val androidSdkVersion = optionalString(sabrObj, "androidSdkVersion") { VERSIONISH_RE.matches(it) } ?: return null
        // `enabled`: absent/null/true = enabled; a strict false benches the SABR capability; any
        // other shape is a malformed entry (same rule as the entry-level kill switch).
        val enabled = when (val e = sabrObj["enabled"]) {
            null, JsonNull -> true
            else -> when ((e as? JsonPrimitive)?.takeIf { !it.isString }?.content) {
                "true" -> true
                "false" -> false
                else -> return null
            }
        }
        return OptionalSabr(
            StreamClientDef.SabrInfo(
                osName = osName.value,
                osVersion = osVersion.value,
                deviceMake = deviceMake.value,
                deviceModel = deviceModel.value,
                androidSdkVersion = androidSdkVersion.value,
                enabled = enabled,
            ),
        )
    }

    /**
     * Families are display metadata only (titles/grouping for the settings toggles) — never a
     * safety surface — so a bad row is skipped non-fatally and a duplicate id keeps the first row.
     * A client whose family has no row here still renders (fallback title = the family id).
     */
    private fun parseFamilies(root: JsonObject): Map<String, FamilyMeta> {
        val array = try {
            root["families"]?.jsonArray ?: return emptyMap()
        } catch (e: Exception) {
            return emptyMap()
        }
        val families = mutableMapOf<String, FamilyMeta>()
        for (element in array) {
            val obj = element as? JsonObject ?: continue
            val id = string(obj, "id")?.takeIf { KEY_RE.matches(it) } ?: continue
            val title = string(obj, "title")?.takeIf { headerSafe(it, 48) } ?: continue
            val group = string(obj, "group")?.takeIf { GROUP_RE.matches(it) } ?: continue
            if (id !in families) families[id] = FamilyMeta(id, title, group)
        }
        return families
    }

    private fun string(obj: JsonObject, field: String): String? =
        (obj[field] as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** Wrapper distinguishing "absent (fine, null value)" from "present but invalid (skip entry)". */
    private class Optional(val value: String?)

    private fun optionalString(obj: JsonObject, field: String, valid: (String) -> Boolean): Optional? {
        // An explicit JSON null means "absent" (the JSON convention, and what the harness loader
        // does): kotlinx returns JsonNull here, NOT null, so without this check `"osName": null`
        // would skip the entry on devices while the pre-push gate accepted it — a silent
        // device/harness divergence.
        val element = obj[field]
        if (element == null || element is JsonNull) return Optional(null)
        val value = (element as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        return if (valid(value)) Optional(value) else null
    }

    /** Strict boolean; absent = false; a non-boolean value invalidates the entry. */
    private fun boolean(obj: JsonObject, field: String): Boolean? {
        // Explicit null == absent == false (see optionalString).
        val element = obj[field]
        if (element == null || element is JsonNull) return false
        val prim = (element as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
        return when (prim.content) {
            "true" -> true
            "false" -> false
            else -> null
        }
    }
}
