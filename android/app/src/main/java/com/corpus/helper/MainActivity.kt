package com.corpus.helper

import android.app.DownloadManager
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.TypedValue
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.corpus.helper.databinding.ActivityMainBinding
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * A window onto whichever Corpus is running on this network.
 *
 * Deliberately a wrapper rather than a native client: Corpus is a web app, and
 * everything in it — the reader, the entries, the graph, study — already works
 * on a phone screen. Rewriting any of that natively would mean two versions of
 * the same thing drifting apart, and the second one always losing.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var ui: ActivityMainBinding
    private lateinit var servers: Servers

    private val found = LinkedHashMap<String, Server>()
    private val lock = Mutex()
    private var scan: Job? = null
    private var connected: Server? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ui = ActivityMainBinding.inflate(layoutInflater)
        setContentView(ui.root)
        servers = Servers(this)

        setUpWebView()

        ui.rescan.setOnClickListener { startScan() }
        ui.manualConnect.setOnClickListener {
            val typed = ui.manualHost.text.toString().trim()
            if (typed.isNotEmpty()) connectManually(typed)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val onConnectScreen = ui.connectPanel.visibility == View.VISIBLE
                when {
                    // Back off the connect screen returns to the page you left,
                    // if there is one; otherwise it leaves.
                    onConnectScreen && connected != null -> showWeb()
                    onConnectScreen -> finish()
                    ui.web.canGoBack() -> ui.web.goBack()
                    // Back from the front page shows the connect screen rather
                    // than quitting, which is also how you switch machines.
                    else -> showConnectScreen()
                }
            }
        })

        reconnectOrScan()
    }

    // -----------------------------------------------------------------------
    // Finding a server
    // -----------------------------------------------------------------------

    /**
     * The machine you used last is tried on its own first. It is one request,
     * it usually succeeds, and it means the common case — same phone, same
     * desk, same computer — opens straight into the library.
     */
    private fun reconnectOrScan() {
        val host = servers.lastHost ?: return startScan()
        val port = servers.lastPort
        showConnecting("Reconnecting to $host…")
        lifecycleScope.launch {
            val server = Discovery.probe(host, port)
            if (server != null) open(server) else startScan()
        }
    }

    private fun startScan() {
        scan?.cancel()
        found.clear()
        ui.serverList.removeAllViews()
        ui.help.visibility = View.GONE

        if (!Discovery.onNetwork(this)) {
            showIdle("This phone is not on a network. Join the Wi-Fi your computer is on.")
            return
        }

        showConnecting("Looking for Corpus on this network…")
        scan = lifecycleScope.launch {
            Discovery.sweep(this@MainActivity) { server ->
                lifecycleScope.launch { record(server) }
            }

            when {
                found.isEmpty() -> {
                    showIdle("No Corpus found on this network.")
                    ui.help.text = HELP
                    ui.help.visibility = View.VISIBLE
                }
                // One machine and no ambiguity: opening it is what you wanted.
                found.size == 1 -> open(found.values.first())
                else -> showIdle("Found ${found.size}. Which one?")
            }
        }
    }

    /** First answer for an address wins; later ones would only redraw the row. */
    private suspend fun record(server: Server) = lock.withLock {
        if (found.containsKey(server.key)) return@withLock
        found[server.key] = server
        addRow(server)
    }

    private fun connectManually(typed: String) {
        scan?.cancel()
        // Scheme first, then the port — the other order turns "http://10.0.0.4"
        // into a host called "http".
        val cleaned = typed.removePrefix("http://").removePrefix("https://").trimEnd('/').trim()
        val host = cleaned.substringBefore(":")
        val port = cleaned.substringAfter(":", "").toIntOrNull() ?: Discovery.DEFAULT_PORT
        showConnecting("Trying $host…")
        lifecycleScope.launch {
            val server = Discovery.probe(host, port)
            if (server != null) {
                open(server)
            } else {
                showIdle("Nothing answered at $host:$port.")
                ui.help.text = HELP
                ui.help.visibility = View.VISIBLE
            }
        }
    }

    // -----------------------------------------------------------------------
    // The connect screen
    // -----------------------------------------------------------------------

    private fun addRow(server: Server) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = ContextCompat.getDrawable(context, R.drawable.card)
            isClickable = true
            setOnClickListener {
                scan?.cancel()
                open(server)
            }
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = dp(10) }
        }
        row.addView(TextView(this).apply {
            text = server.name
            setTextColor(ContextCompat.getColor(context, R.color.ink))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
        })
        row.addView(TextView(this).apply {
            text = "${server.host}  ·  ${server.summary()}"
            setTextColor(ContextCompat.getColor(context, R.color.muted))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        })
        ui.serverList.addView(row)
    }

    private fun showConnecting(message: String) {
        ui.status.text = message
        ui.progress.visibility = View.VISIBLE
        ui.connectPanel.visibility = View.VISIBLE
    }

    private fun showIdle(message: String) {
        ui.status.text = message
        ui.progress.visibility = View.GONE
    }

    private fun showWeb() {
        ui.connectPanel.visibility = View.GONE
        ui.web.visibility = View.VISIBLE
    }

    /** Reached by pressing back from a library's front page: how you switch. */
    private fun showConnectScreen() {
        ui.connectPanel.visibility = View.VISIBLE
        if (found.isEmpty()) startScan() else showIdle("Connected to ${connected?.name ?: "—"}.")
    }

    // -----------------------------------------------------------------------
    // The library itself
    // -----------------------------------------------------------------------

    /**
     * Callers cancel the scan themselves where it matters. Doing it in here
     * would mean the scan cancelling itself from inside its own coroutine at
     * the moment it decides to open the one server it found.
     */
    private fun open(server: Server) {
        // A Corpus in LAN mode wants its token before it will show anything.
        // The WebView cannot be told to add a header to every request it makes
        // — only to the first — so the token is handed over once through
        // /login, which sets a cookie the WebView then carries by itself.
        if (server.needsToken) {
            val token = servers.tokenFor(server.host)
            if (token.isNullOrBlank()) {
                askForToken(server)
                return
            }
            connected = server
            servers.remember(server)
            ui.progress.visibility = View.GONE
            ui.web.loadUrl(server.url + "/login?token=" + Uri.encode(token))
            showWeb()
            return
        }

        connected = server
        servers.remember(server)
        ui.progress.visibility = View.GONE
        ui.web.loadUrl(server.url)
        showWeb()
    }

    /**
     * Asks for the token, once per machine.
     *
     * It is shown on the computer, in Settings, as a link to scan or a code to
     * type. A wrong one is rejected here rather than by a page the WebView
     * would render as a bare 401, which reads as "Corpus is broken".
     */
    private fun askForToken(server: Server) {
        val input = EditText(this).apply {
            hint = "Token from Settings on the computer"
            isSingleLine = true
            setTextColor(ContextCompat.getColor(context, R.color.ink))
        }
        AlertDialog.Builder(this)
            .setTitle(server.name)
            .setMessage(
                "This Corpus is open to the network, so it needs its token. " +
                    "Open Settings on the computer running it — the token is there, " +
                    "with a link you can scan."
            )
            .setView(input)
            .setPositiveButton("Connect") { _, _ ->
                val typed = input.text.toString().trim()
                if (typed.isEmpty()) return@setPositiveButton
                showConnecting("Checking the token…")
                lifecycleScope.launch {
                    if (Discovery.tokenWorks(server.host, server.port, typed)) {
                        servers.rememberToken(server.host, typed)
                        open(server)
                    } else {
                        servers.forgetToken(server.host)
                        showIdle("That token was not accepted by ${server.name}.")
                    }
                }
            }
            .setNegativeButton("Cancel") { _, _ -> showIdle("Not connected.") }
            .show()
    }

    private fun setUpWebView() {
        ui.web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Corpus lays out for a phone already; letting the WebView invent a
            // desktop viewport would undo that.
            useWideViewPort = false
            loadWithOverviewMode = false
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = false
        }
        ui.web.setBackgroundColor(Color.TRANSPARENT)

        ui.web.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView?,
                request: android.webkit.WebResourceRequest?,
                error: android.webkit.WebResourceError?,
            ) {
                // Only a failure of the page itself is worth surfacing; a failed
                // sub-resource should not throw you out of what you are reading.
                if (request?.isForMainFrame != true) return
                connected = null
                showIdle("Lost the connection. Is Corpus still running?")
                ui.connectPanel.visibility = View.VISIBLE
                ui.web.visibility = View.GONE
                ui.help.text = HELP
                ui.help.visibility = View.VISIBLE
            }
        }

        // Exports are ordinary downloads; hand them to the system so they land
        // in Downloads like anything else.
        ui.web.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            try {
                val request = DownloadManager.Request(android.net.Uri.parse(url)).apply {
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setMimeType(mimeType)
                    val name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType)
                    setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, name)
                }
                (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this, "Downloading…", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this, "Could not download: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onDestroy() {
        scan?.cancel()
        super.onDestroy()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        /**
         * The two things that are actually ever wrong, in the order they are
         * usually wrong in. Windows blocks incoming connections by default, and
         * that is invisible from the phone — it looks exactly like Corpus not
         * running at all.
         */
        const val HELP =
            "Two things to check:\n\n" +
                "1. Corpus is running on the computer — its icon is in the system tray.\n\n" +
                "2. Windows Firewall is letting it through. It blocks incoming connections " +
                "by default, which from here looks the same as Corpus being switched off. " +
                "The Corpus README has the one command that fixes it.\n\n" +
                "Both devices also have to be on the same Wi-Fi — a guest network will not " +
                "reach your computer."
    }
}
