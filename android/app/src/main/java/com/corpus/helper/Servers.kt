package com.corpus.helper

import android.content.Context

/**
 * The last machine you actually used.
 *
 * Only one is kept, and its address plus, when the library asks for one, its
 * token. Anything else — how big the library is, what the machine calls itself
 * — is asked for fresh, because it changes and a stale answer on the connect
 * screen is worse than no answer.
 *
 * The token is what a Raazi in LAN mode requires on every request: it is
 * generated on the computer and shown in Settings there, as a link to open or
 * a code to type here. Kept in the app's own private preferences, which is
 * where the WebView's cookies live too — the same trust boundary, not a
 * weaker one.
 */
class Servers(context: Context) {

    private val prefs = context.getSharedPreferences("corpus", Context.MODE_PRIVATE)

    var lastHost: String?
        get() = prefs.getString(KEY_HOST, null)
        private set(value) {
            prefs.edit().putString(KEY_HOST, value).apply()
        }

    var lastPort: Int
        get() = prefs.getInt(KEY_PORT, Discovery.DEFAULT_PORT)
        private set(value) {
            prefs.edit().putInt(KEY_PORT, value).apply()
        }

    /**
     * The token for one machine, kept per address rather than globally: two
     * Corpuses on the same network have different tokens, and carrying one to
     * the other would simply fail.
     */
    fun tokenFor(host: String): String? = prefs.getString(tokenKey(host), null)

    fun rememberToken(host: String, token: String) {
        prefs.edit().putString(tokenKey(host), token.trim()).apply()
    }

    fun forgetToken(host: String) {
        prefs.edit().remove(tokenKey(host)).apply()
    }

    fun remember(server: Server) {
        lastHost = server.host
        lastPort = server.port
    }

    fun forget() {
        prefs.edit().remove(KEY_HOST).remove(KEY_PORT).apply()
    }

    private fun tokenKey(host: String) = "token_" + host

    private companion object {
        const val KEY_HOST = "last_host"
        const val KEY_PORT = "last_port"
    }
}
