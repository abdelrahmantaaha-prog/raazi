package com.corpus.helper

import android.content.Context

/**
 * The last machine you actually used.
 *
 * Only one is kept, and only its address. Anything else — how big the library
 * is, what the machine calls itself — is asked for fresh, because it changes
 * and a stale answer on the connect screen is worse than no answer.
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

    fun remember(server: Server) {
        lastHost = server.host
        lastPort = server.port
    }

    fun forget() {
        prefs.edit().remove(KEY_HOST).remove(KEY_PORT).apply()
    }

    private companion object {
        const val KEY_HOST = "last_host"
        const val KEY_PORT = "last_port"
    }
}
