package com.lymoon.raazi

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkAddress
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.URL

/** A Raazi that answered for itself. */
data class Server(
    val host: String,
    val port: Int,
    val name: String,
    val sources: Int,
    val entities: Int,
    val entries: Int,
    /**
     * Whether this Raazi is in LAN mode, and so wants its token on every
     * request but this one. /api/hello answers before any token is offered —
     * it has to, or a phone could never find the machine to sign in to it.
     */
    val needsToken: Boolean = false,
) {
    val url: String get() = "http://$host:$port"
    val key: String get() = "$host:$port"

    /** "412 sources · 1,204 entries" — enough to tell two machines apart. */
    fun summary(): String = buildString {
        append(sources).append(if (sources == 1) " source" else " sources")
        append(" · ").append(entries).append(if (entries == 1) " entry" else " entries")
    }
}

/**
 * Finding Raazi on the network.
 *
 * By asking every address on this phone's subnet at once whether it is a
 * Raazi. It is a blunt method and a good one: it needs nothing of the network
 * beyond that the two devices can reach each other, and it finishes in about a
 * second.
 *
 * An mDNS announcement was the obvious alternative and was tried first. It
 * would have been instant, but it needs a responder inside the Raazi server,
 * and every pure-JS one reaches for `dgram` in a way Next's bundler will not
 * allow — the attempt took the whole site down twice. Multicast is also dropped
 * by a good many home access points, so the sweep would have had to exist
 * regardless. Two mechanisms where one suffices is one too many.
 */
object Discovery {

    const val DEFAULT_PORT = 5400
    private const val TAG = "RaaziDiscovery"

    private const val CONNECT_MS = 400
    private const val READ_MS = 900
    /** Enough sockets to sweep a /24 quickly without exhausting the file table. */
    private const val PARALLEL = 48

    /** The header a Raazi in LAN mode checks on every request. */
    const val TOKEN_HEADER = "x-corpus-token"

    /**
     * Whether a token opens this Raazi.
     *
     * Asked against a route that is behind the check — /api/settings, which is
     * cheap and answers JSON — because /api/hello is deliberately open and
     * would say yes to anything.
     */
    suspend fun tokenWorks(host: String, port: Int, token: String): Boolean =
        withContext(Dispatchers.IO) {
            var conn: HttpURLConnection? = null
            try {
                conn = (URL("http://$host:$port/api/settings").openConnection() as HttpURLConnection).apply {
                    connectTimeout = 3_000
                    readTimeout = 5_000
                    requestMethod = "GET"
                    instanceFollowRedirects = false
                    setRequestProperty(TOKEN_HEADER, token)
                }
                conn.responseCode == 200
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                false
            } finally {
                conn?.disconnect()
            }
        }

    /**
     * Asks one address whether it is a Raazi.
     *
     * Everything about this is deliberately impatient: it runs against a couple
     * of hundred addresses that are mostly phones, printers and nothing at all,
     * and a slow answer is as good as no answer.
     */
    suspend fun probe(host: String, port: Int = DEFAULT_PORT, patienceMs: Int = CONNECT_MS): Server? = withContext(Dispatchers.IO) {
        var conn: HttpURLConnection? = null
        try {
            conn = (URL("http://$host:$port/api/hello").openConnection() as HttpURLConnection).apply {
                connectTimeout = patienceMs
                // A computer asked for by name may be busy; one swept for need not be.
                readTimeout = maxOf(READ_MS, patienceMs * 3)
                requestMethod = "GET"
                // A redirect means something else is listening here.
                instanceFollowRedirects = false
                setRequestProperty("accept", "application/json")
            }
            if (conn.responseCode != 200) return@withContext null

            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            // The marker is the whole point: without it, anything answering 200
            // on this port would be listed as a library.
            if (json.optString("app") != "corpus") return@withContext null

            val library = json.optJSONObject("library")
            Server(
                host = host,
                port = json.optInt("port", port),
                name = json.optString("host").ifBlank { host },
                sources = library?.optInt("sources") ?: 0,
                entities = library?.optInt("entities") ?: 0,
                entries = library?.optInt("entries") ?: 0,
                needsToken = json.optBoolean("lan", false),
            )
        } catch (e: CancellationException) {
            throw e
        } catch (_: IOException) {
            null
        } catch (_: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    /**
     * The 254 addresses of the /24 this phone sits in, asked all at once.
     *
     * Always the enclosing /24, never the advertised prefix: a wider one — some
     * corporate networks and mobile hotspots hand out a /16 — would mean sixty
     * thousand probes for no gain, since a desktop on the same network is
     * essentially always in the same /24. On a narrower prefix the extra probes
     * simply find nothing.
     */
    suspend fun sweep(context: Context, port: Int = DEFAULT_PORT, onFound: (Server) -> Unit) {
        val local = localAddress(context) ?: run {
            Log.w(TAG, "no IPv4 address; is Wi-Fi connected?")
            return
        }
        val octets = local.address.address
        if (octets.size != 4) return

        val gate = Semaphore(PARALLEL)
        coroutineScope {
            for (last in 1..254) {
                val candidate = "%d.%d.%d.%d".format(
                    octets[0].toInt() and 0xFF,
                    octets[1].toInt() and 0xFF,
                    octets[2].toInt() and 0xFF,
                    last,
                )
                launch {
                    gate.withPermit {
                        probe(candidate, port)?.let(onFound)
                    }
                }
            }
        }
    }

    /** This phone's own IPv4 address on the current network. */
    private fun localAddress(context: Context): LinkAddress? {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return null
        val network = cm.activeNetwork ?: return null
        val props = cm.getLinkProperties(network) ?: return null
        return props.linkAddresses.firstOrNull {
            it.address is Inet4Address && !it.address.isLoopbackAddress
        }
    }

    /** Whether a sweep can even be attempted — i.e. is there a local network. */
    fun onNetwork(context: Context): Boolean = localAddress(context) != null
}
