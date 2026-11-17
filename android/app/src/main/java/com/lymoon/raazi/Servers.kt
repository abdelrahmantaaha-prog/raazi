package com.lymoon.raazi

import android.content.Context

/**
 * The machines you have actually used, most recent first.
 *
 * Kept as addresses ("192.168.1.20:5400"), a handful at most: the home Wi-Fi
 * address of the computer and, if you use Tailscale, its address from away —
 * so opening the app on the train still goes straight in. Anything else (how
 * big the library is, what the machine calls itself) is asked for fresh,
 * because it changes and a stale answer is worse than none.
 *
 * The token is what a Raazi in LAN mode requires on every request: it comes
 * from the code on the computer's Settings page, or is pasted. Kept per
 * address in the app's private preferences, which is where the WebView's
 * cookies live too — the same trust boundary, not a weaker one.
 */
class Servers(context: Context) {

    private val prefs = context.getSharedPreferences("raazi", Context.MODE_PRIVATE)

    /** host:port, most recent first. */
    val recent: List<Pair<String, Int>>
        get() = (prefs.getString(KEY_RECENT, null) ?: "")
            .split('\n')
            .mapNotNull { line ->
                val host = line.substringBeforeLast(':', "").ifBlank { return@mapNotNull null }
                val port = line.substringAfterLast(':').toIntOrNull() ?: return@mapNotNull null
                host to port
            }

    fun remember(server: Server) {
        val key = "${server.host}:${server.port}"
        val rest = recent.map { "${it.first}:${it.second}" }.filter { it != key }
        prefs.edit().putString(KEY_RECENT, (listOf(key) + rest).take(MAX_RECENT).joinToString("\n")).apply()
    }

    /**
     * The token for one machine. Kept per address: two Raazis on one network
     * have different tokens. A token that works for one address of a machine
     * works for all of them, so a machine found under a new address is offered
     * the tokens already known before anyone is asked.
     */
    fun tokenFor(host: String): String? = prefs.getString(tokenKey(host), null)

    fun knownTokens(): List<String> =
        prefs.all.filterKeys { it.startsWith("token_") }.values.filterIsInstance<String>().distinct()

    fun rememberToken(host: String, token: String) {
        prefs.edit().putString(tokenKey(host), token.trim()).apply()
    }

    fun forgetToken(host: String) {
        prefs.edit().remove(tokenKey(host)).apply()
    }

    private fun tokenKey(host: String) = "token_" + host

    private companion object {
        const val KEY_RECENT = "recent"
        const val MAX_RECENT = 5
    }
}
