package com.lymoon.raazi

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.lymoon.raazi.databinding.ActivityMainBinding
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

/**
 * Raazi on the phone: finds the Raazi running on your network and opens it.
 *
 * Deliberately a window onto the web app rather than a second app: everything
 * in Raazi — the inbox, the reader, the pedia — already lays itself out for a
 * phone, and a native copy would be a second version always running behind.
 * What the phone adds is what a browser tab cannot do: finding the computer by
 * itself, its own voices for Listen, the back button, the screen staying on
 * while you read, and files and downloads through Android's own pickers.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var ui: ActivityMainBinding
    private lateinit var servers: Servers
    private lateinit var voice: PhoneVoice

    private val found = LinkedHashMap<String, Server>()
    private val lock = Mutex()
    private var scan: Job? = null
    private var connected: Server? = null

    /** The page's end of the bridge; replaced whenever a page says hello. */
    private var reply: JavaScriptReplyProxy? = null
    private var bridgeOrigin: String? = null
    private var shim: ScriptHandler? = null
    private val main = Handler(Looper.getMainLooper())

    /** The sign-in box, while it is up: connecting another way (a scan, a link) closes it. */
    private var tokenDialog: AlertDialog? = null

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        val uris: Array<Uri>? = when {
            result.resultCode != RESULT_OK -> null
            data?.clipData != null -> Array(data.clipData!!.itemCount) { data.clipData!!.getItemAt(it).uri }
            data?.data != null -> arrayOf(data.data!!)
            else -> null
        }
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        ui = ActivityMainBinding.inflate(layoutInflater)
        setContentView(ui.root)
        servers = Servers(this)
        // A debug build's pages can be inspected from the computer's browser.
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        voice = PhoneVoice(this) { json -> main.post { reply?.postMessage(json) } }

        fitToBars()
        setUpWebView()

        ui.rescan.setOnClickListener { startScan() }
        ui.scanCode.setOnClickListener { scanCode() }
        ui.manualConnect.setOnClickListener {
            val typed = ui.manualHost.text.toString().trim()
            if (typed.isNotEmpty()) connectTyped(typed)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = goBack()
        })

        // Opened from a scanned sign-in link (the camera app, or a link sent
        // to yourself): connect to exactly that.
        val link = intent?.data
        if (link != null) connectLink(link.toString()) else reconnectOrScan()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.let { connectLink(it.toString()) }
    }

    /**
     * Edge to edge is the rule on Android 15, so the bars are drawn over the
     * window unless something makes room. The keyboard too: without its inset
     * a text box at the bottom of a page types out of sight.
     */
    private fun fitToBars() {
        ViewCompat.setOnApplyWindowInsetsListener(ui.root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }
    }

    // -----------------------------------------------------------------------
    // Finding a server
    // -----------------------------------------------------------------------

    /**
     * The machines used before are asked first, all at once: the computer's
     * home address and, if you use Tailscale, its address from away. That is
     * normally one quick answer, straight into the library. Only if none of
     * them answers is the network swept.
     */
    private fun reconnectOrScan() {
        val recent = servers.recent
        if (recent.isEmpty()) return startScan()
        showConnecting("Connecting…")
        scan?.cancel()
        scan = lifecycleScope.launch {
            val answers = recent.map { (host, port) -> async { Discovery.probe(host, port, RECENT_PATIENCE_MS) } }.awaitAll()
            // The most recently used of those that answered.
            val server = answers.firstOrNull { it != null }
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

        showConnecting("Looking for Raazi on this network…")
        scan = lifecycleScope.launch {
            Discovery.sweep(this@MainActivity) { server ->
                lifecycleScope.launch { record(server) }
            }

            when {
                found.isEmpty() -> {
                    showIdle("No Raazi found on this network.")
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

    /** An address, or a whole sign-in link pasted from the computer. */
    private fun connectTyped(typed: String) {
        if (typed.contains("token=")) return connectLink(typed)
        scan?.cancel()
        // Scheme first, then the port — the other order turns "http://10.0.0.4"
        // into a host called "http".
        val cleaned = typed.removePrefix("http://").removePrefix("https://").substringBefore('/').trim()
        val host = cleaned.substringBefore(":")
        val port = cleaned.substringAfter(":", "").toIntOrNull() ?: Discovery.DEFAULT_PORT
        showConnecting("Trying $host…")
        lifecycleScope.launch {
            val server = Discovery.probe(host, port, RECENT_PATIENCE_MS)
            if (server != null) {
                open(server)
            } else {
                showIdle("Nothing answered at $host:$port.")
                ui.help.text = HELP
                ui.help.visibility = View.VISIBLE
            }
        }
    }

    /**
     * The sign-in link — http://address:5400/login?token=… — from the code on
     * the computer's Settings page. It says where and how in one go.
     */
    private fun connectLink(link: String) {
        tokenDialog?.dismiss()
        tokenDialog = null
        val uri = runCatching { Uri.parse(link.trim()) }.getOrNull()
        val host = uri?.host
        val token = uri?.getQueryParameter("token")
        if (host.isNullOrBlank() || token.isNullOrBlank()) {
            showIdle("That is not a Raazi sign-in link.")
            return
        }
        val port = if (uri.port > 0) uri.port else Discovery.DEFAULT_PORT
        scan?.cancel()
        showConnecting("Connecting to $host…")
        lifecycleScope.launch {
            val server = Discovery.probe(host, port, RECENT_PATIENCE_MS)
            when {
                server == null -> {
                    showIdle("Nothing answered at $host:$port. Is the phone on the same Wi-Fi?")
                    ui.help.text = HELP
                    ui.help.visibility = View.VISIBLE
                }
                !server.needsToken || Discovery.tokenWorks(host, port, token) -> {
                    servers.rememberToken(host, token)
                    open(server)
                }
                else -> showIdle("${server.name} did not accept that code. Show it again in Settings and rescan.")
            }
        }
    }

    private fun scanCode() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { code -> code.rawValue?.let(::connectLink) }
            .addOnFailureListener {
                Toast.makeText(
                    this,
                    "The scanner is not available on this phone. Paste the sign-in link instead.",
                    Toast.LENGTH_LONG,
                ).show()
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
        if (found.isEmpty() && connected == null) startScan()
        else showIdle(connected?.let { "Connected to ${it.name}. Back returns to it." } ?: "Not connected.")
    }

    private fun goBack() {
        val onConnectScreen = ui.connectPanel.visibility == View.VISIBLE
        when {
            onConnectScreen && connected != null -> showWeb()
            onConnectScreen -> finish()
            // An open sheet, drawer or book closes first; the page asks itself.
            else -> ui.web.evaluateJavascript("(window.__raaziBack && window.__raaziBack()) || false") { handled ->
                if (handled == "true") return@evaluateJavascript
                if (ui.web.canGoBack()) ui.web.goBack() else showConnectScreen()
            }
        }
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
        // A Raazi in LAN mode wants its token before it will show anything.
        // The WebView cannot be told to add a header to every request it makes
        // — only to the first — so the token is handed over once through
        // /login, which sets a cookie the WebView then carries by itself.
        if (server.needsToken) {
            val token = servers.tokenFor(server.host)
            if (token.isNullOrBlank()) {
                tryKnownTokens(server)
                return
            }
            show(server, server.url + "/login?token=" + Uri.encode(token))
            return
        }
        show(server, server.url)
    }

    private fun show(server: Server, url: String) {
        connected = server
        servers.remember(server)
        ui.progress.visibility = View.GONE
        bridgeTo(server.url)
        ui.web.loadUrl(url)
        showWeb()
    }

    /**
     * The same computer under a new address (home Wi-Fi vs Tailscale, or a
     * router that handed out a new one) takes the token it already gave.
     */
    private fun tryKnownTokens(server: Server) {
        val known = servers.knownTokens()
        if (known.isEmpty()) return askForToken(server)
        showConnecting("Signing in to ${server.name}…")
        lifecycleScope.launch {
            val works = known.firstOrNull { Discovery.tokenWorks(server.host, server.port, it) }
            if (works != null) {
                servers.rememberToken(server.host, works)
                open(server)
            } else {
                askForToken(server)
            }
        }
    }

    /**
     * Asks for the token, once per machine: by scanning the code on the
     * computer's Settings page, or pasting the sign-in link or the token.
     */
    private fun askForToken(server: Server) {
        val input = EditText(this).apply {
            hint = "Sign-in link or token"
            isSingleLine = true
            setTextColor(ContextCompat.getColor(context, R.color.ink))
        }
        showIdle("${server.name} needs signing in, once.")
        tokenDialog?.dismiss()
        tokenDialog = AlertDialog.Builder(this)
            .setTitle("Sign in to ${server.name}")
            .setMessage(
                "On the computer, open Raazi → Settings → Phone & other laptop → Show the code, and scan it. " +
                    "Or paste the sign-in link or the token from there."
            )
            .setView(input)
            .setPositiveButton("Connect") { _, _ ->
                val typed = input.text.toString().trim()
                if (typed.isEmpty()) return@setPositiveButton
                if (typed.contains("token=")) return@setPositiveButton connectLink(typed)
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
            .setNeutralButton("Scan the code") { _, _ -> scanCode() }
            .setNegativeButton("Cancel") { _, _ -> showIdle("Not connected.") }
            .setOnDismissListener { tokenDialog = null }
            .show()
    }

    /**
     * The bridge phone.js talks through, offered to Raazi's own address only:
     * the inbox can show other sites' pages inside it, and those must not be
     * able to reach the phone. Re-made whenever the address changes.
     */
    private fun bridgeTo(origin: String) {
        if (origin == bridgeOrigin) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        if (bridgeOrigin != null) WebViewCompat.removeWebMessageListener(ui.web, BRIDGE)
        shim?.remove()
        shim = null
        reply = null
        bridgeOrigin = origin
        WebViewCompat.addWebMessageListener(ui.web, BRIDGE, setOf(origin)) { _, message, _, isMainFrame, proxy ->
            if (!isMainFrame) return@addWebMessageListener
            val m = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return@addWebMessageListener
            if (m.optString("op") == "hello") reply = proxy
            if (m.optString("op") == "awake") keepAwake(m.optBoolean("on")) else voice.handle(m)
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            shim = WebViewCompat.addDocumentStartJavaScript(ui.web, phoneScript, setOf(origin))
        }
    }

    private val phoneScript: String by lazy { assets.open("phone.js").bufferedReader().use { it.readText() } }

    private fun keepAwake(on: Boolean) {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWebView() {
        ui.web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Raazi lays out for a phone already; letting the WebView invent a
            // desktop viewport would undo that.
            useWideViewPort = false
            loadWithOverviewMode = false
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = false
            // "Open the article" uses window.open; it arrives below as a
            // navigation and goes to the phone's browser.
            javaScriptCanOpenWindowsAutomatically = true
        }
        ui.web.setBackgroundColor(Color.TRANSPARENT)
        CookieManager.getInstance().setAcceptCookie(true)

        ui.web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                val url = request.url
                val here = connected ?: return false
                val ours = url.host == here.host && (url.port == here.port || (url.port == -1 && here.port == 80))
                if (ours) return false
                // An article, a source, a map: the phone's browser, not this window.
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
                    true
                } catch (_: ActivityNotFoundException) {
                    false
                }
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                // A new page has asked for nothing yet.
                keepAwake(false)
                // Older WebViews cannot run a script before the page; this
                // is the next best moment.
                if (shim == null && url != null && connected != null && url.startsWith(connected!!.url)) {
                    view?.evaluateJavascript(phoneScript, null)
                }
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                // Only a failure of the page itself is worth surfacing; a failed
                // sub-resource should not throw you out of what you are reading.
                if (request?.isForMainFrame != true) return
                connected = null
                ui.web.visibility = View.GONE
                ui.help.text = HELP
                ui.help.visibility = View.VISIBLE
                // The computer may only have moved (a new address, or Tailscale
                // instead of Wi-Fi): look for it before giving up.
                reconnectOrScan()
            }
        }

        ui.web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val intent = params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).setType("*/*")
                if (params?.mode == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                // Raazi's file boxes list several extensions at once, which
                // Android's picker reads as "none of these": let it show all.
                intent.type = "*/*"
                return try {
                    pickFiles.launch(intent)
                    true
                } catch (_: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }
        }

        // Exports are ordinary downloads; hand them to the system so they land
        // in Downloads like anything else — with the sign-in cookie, or a
        // Raazi in LAN mode would answer the download manager with a 401.
        ui.web.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            try {
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setMimeType(mimeType)
                    CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
                    addRequestHeader("User-Agent", userAgent)
                    val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
                    setTitle(name)
                    setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                }
                (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this, "Downloading…", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this, "Could not download: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        scan?.cancel()
        voice.shutdown()
        super.onDestroy()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        const val BRIDGE = "RaaziPhone"
        /** A remembered address may be Tailscale, across the internet: more patience than the sweep's. */
        const val RECENT_PATIENCE_MS = 2_500

        /**
         * The two things that are actually ever wrong, in the order they are
         * usually wrong in. Windows blocks incoming connections by default, and
         * that is invisible from the phone — it looks exactly like Raazi not
         * running at all.
         */
        const val HELP =
            "Things to check:\n\n" +
                "1. Raazi is running on the computer — its icon is in the system tray.\n\n" +
                "2. Sharing is on: Raazi → Settings → Phone & other laptop → \"Shared\".\n\n" +
                "3. Windows Firewall is letting it through. It blocks incoming connections " +
                "by default, which from here looks the same as Raazi being switched off.\n\n" +
                "Both devices also have to be on the same Wi-Fi — a guest network will not " +
                "reach your computer. Away from home, Tailscale on both works too."
    }
}
