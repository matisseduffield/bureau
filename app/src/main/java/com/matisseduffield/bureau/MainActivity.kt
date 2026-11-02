package com.matisseduffield.bureau

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import com.matisseduffield.bureau.alerts.Alerts
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.matisseduffield.bureau.updates.UpdateManager
import com.matisseduffield.bureau.widget.RateWidget
import com.matisseduffield.bureau.widget.WidgetStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * Hosts web/index.html (bundled as assets) in a WebView. The asset loader
 * serves it from a real https origin, so localStorage and the rate APIs'
 * CORS behave exactly as they do in a browser. A message bridge, limited to
 * that origin, lets the page drive the Back gesture, the home-screen widget
 * and on-demand update checks.
 */
class MainActivity : ComponentActivity() {
    private companion object {
        const val APP_HOST = WebViewAssetLoader.DEFAULT_DOMAIN
        const val APP_ORIGIN = "https://$APP_HOST"
        const val START_URL = "$APP_ORIGIN/assets/index.html"
        const val BRIDGE_NAME = "bureauApp"
        const val CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L

        // The page's bureauBack() closes the fee menu or the currency picker,
        // whichever is open, and says whether it closed anything.
        const val CLOSE_PICKER_JS =
            "(() => typeof bureauBack === 'function' && bureauBack() === true)()"
    }

    private lateinit var web: WebView
    private var lastUpdateCheck = 0L
    private var updatePromptOpen = false
    private var page: JavaScriptReplyProxy? = null
    private val bridgeSupported by lazy { WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) }
    private var pendingUpdate: UpdateManager.UpdateInfo? = null
    private var installing = false
    private var alertPair: kotlin.Pair<String, String>? = null
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { sendAlerts() }

    // With the bridge, Back is only intercepted while the currency picker or
    // fee menu is open (the page's "picker" message), so the system's
    // predictive back gesture works everywhere else.
    private val closePicker = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            web.evaluateJavascript(CLOSE_PICKER_JS, null)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            setBackgroundColor(getColor(R.color.page_bg))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            // Follow the phone's font size setting.
            settings.textZoom = (resources.configuration.fontScale * 100).toInt()
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? = assets.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.host == APP_HOST) return false
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                    return true
                }
            }
        }

        val root = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.page_bg))
            addView(web)
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, BRIDGE_NAME, setOf(APP_ORIGIN)) { _, message, origin, isMainFrame, reply ->
                if (isMainFrame && origin == APP_ORIGIN.toUri()) onPageMessage(message, reply)
            }
            onBackPressedDispatcher.addCallback(this, closePicker)
        } else {
            // Older WebView without the bridge: always ask the page first.
            onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    web.evaluateJavascript(CLOSE_PICKER_JS) { closed ->
                        if (closed != "true") moveTaskToBack(true)
                    }
                }
            })
        }
        web.loadUrl(START_URL)
        takeAlertPair(intent)

        // A downloaded update has done its job once the new version is running.
        if (savedInstanceState == null) {
            lifecycleScope.launch(Dispatchers.IO) { File(cacheDir, "updates").deleteRecursively() }
        }

        lifecycleScope.launch {
            UpdateManager.installError.collect { message ->
                if (message != null) {
                    if (installing) {
                        installing = false
                        sendUpdateState("failed") { put("message", message) }
                    } else {
                        Toast.makeText(this@MainActivity, message, Toast.LENGTH_LONG).show()
                    }
                    UpdateManager.installError.value = null
                }
            }
        }
    }

    // Out of sight, the page's timers and rate polling stop entirely; they
    // resume (and refresh stale rates) as soon as the app is back.
    override fun onResume() {
        super.onResume()
        web.onResume()
        web.resumeTimers()
        maybeCheckForUpdate()
        if (page != null) sendAlerts()
    }

    override fun onPause() {
        web.onPause()
        web.pauseTimers()
        super.onPause()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    private fun onPageMessage(message: WebMessageCompat, reply: JavaScriptReplyProxy) {
        val msg = runCatching { JSONObject(message.data ?: return) }.getOrNull() ?: return
        when (msg.optString("type")) {
            "hello" -> {
                page = reply
                send(JSONObject().put("type", "info").put("version", BuildConfig.VERSION_NAME))
                pendingUpdate?.let { sendUpdateCard(it) }
                sendAlerts()
                sendAlertPair()
            }
            "picker" -> closePicker.isEnabled = msg.optBoolean("open")
            "pair" -> {
                val from = msg.optString("from")
                val to = msg.optString("to")
                val rate = msg.optDouble("rate")
                val amount = msg.optDouble("amount", 1.0).takeIf { it.isFinite() && it > 0 } ?: 1.0
                if (from.isNotBlank() && to.isNotBlank() && rate.isFinite() && rate > 0) {
                    WidgetStore.save(
                        this,
                        WidgetStore.Pair(from, to, msg.optDouble("fee", 0.0), rate, msg.optLong("updatedAt"), amount),
                    )
                    RateWidget.updateAll(this)
                }
            }
            "setAlert" -> {
                val target = msg.optDouble("target")
                val from = msg.optString("from")
                val to = msg.optString("to")
                if (from.isNotBlank() && to.isNotBlank() && target.isFinite() && target > 0) {
                    Alerts.set(this, Alerts.Alert(from, to, target, msg.optBoolean("above")))
                    if (Build.VERSION.SDK_INT >= 33 && !Alerts.notificationsOn(this)) {
                        askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                }
                sendAlerts()
            }
            "removeAlert" -> {
                Alerts.remove(this, msg.optString("from"), msg.optString("to"))
                sendAlerts()
            }
            "notificationSettings" -> runCatching {
                startActivity(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName),
                )
            }
            // System tap feedback; Android skips it if touch feedback is off.
            "haptic" -> web.performHapticFeedback(
                if (msg.optString("kind") == "tick") HapticFeedbackConstants.CLOCK_TICK
                else HapticFeedbackConstants.VIRTUAL_KEY,
            )
            "checkUpdate" -> checkForUpdateNow()
            "installUpdate" -> pendingUpdate?.let { installFromCard(it) }
        }
    }

    // ---- update card ----
    // With the bridge, updates appear as a card in the page; the system dialog
    // below is only the fallback for WebViews without it.

    private fun onUpdateAvailable(info: UpdateManager.UpdateInfo) {
        if (!bridgeSupported) {
            if (!updatePromptOpen) offerUpdate(info)
            return
        }
        pendingUpdate = info
        sendUpdateCard(info) // no-op until the page has said hello; "hello" sends it then
    }

    private fun sendUpdateCard(info: UpdateManager.UpdateInfo) {
        if (installing) return
        send(
            JSONObject()
                .put("type", "update")
                .put("state", "available")
                .put("version", info.versionName)
                .put("size", info.sizeBytes)
                .put("notes", JSONArray(info.notes)),
        )
    }

    private fun sendUpdateState(state: String, extra: JSONObject.() -> Unit = {}) {
        runOnUiThread { send(JSONObject().put("type", "update").put("state", state).apply(extra)) }
    }

    private fun installFromCard(info: UpdateManager.UpdateInfo) {
        if (installing) return
        installing = true
        lifecycleScope.launch {
            try {
                var lastPct = -1
                val apk = UpdateManager.download(this@MainActivity, info) { fraction ->
                    val pct = (fraction * 100).toInt()
                    if (pct != lastPct) {
                        lastPct = pct
                        sendUpdateState("downloading") { put("progress", fraction.toDouble()) }
                    }
                }
                sendUpdateState("installing")
                UpdateManager.install(this@MainActivity, apk)
            } catch (e: Exception) {
                installing = false
                sendUpdateState("failed") { put("message", e.message ?: "The download didn't finish.") }
            }
        }
    }

    // Only reachable when WEB_MESSAGE_LISTENER is supported: [page] is set by a bridge message.
    @SuppressLint("RequiresFeature")
    private fun send(json: JSONObject) {
        runCatching { page?.postMessage(json.toString()) }
    }

    // ---- rate alerts ----

    /** The page's copy of the alerts; alerts that fired in the background have gone. */
    private fun sendAlerts() {
        send(
            JSONObject()
                .put("type", "alerts")
                .put("list", Alerts.toJson(Alerts.load(this)))
                .put("notify", Alerts.notificationsOn(this)),
        )
    }

    /** Opened from an alert's notification: show that pair. */
    private fun takeAlertPair(intent: Intent?) {
        val from = intent?.getStringExtra(Alerts.EXTRA_FROM) ?: return
        val to = intent.getStringExtra(Alerts.EXTRA_TO) ?: return
        alertPair = from to to
        intent.removeExtra(Alerts.EXTRA_FROM)
        sendAlertPair()
    }

    private fun sendAlertPair() {
        val (from, to) = alertPair ?: return
        if (page == null) return // sent on "hello"
        send(JSONObject().put("type", "showPair").put("from", from).put("to", to))
        alertPair = null
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeAlertPair(intent)
    }

    /** Result of a check the page asked for: "available", "latest" or "failed". */
    private fun sendUpdateStatus(state: String) {
        send(JSONObject().put("type", "updateStatus").put("state", state))
    }

    private fun checkForUpdateNow() {
        lastUpdateCheck = System.currentTimeMillis()
        lifecycleScope.launch {
            when (val result = UpdateManager.check()) {
                is UpdateManager.CheckResult.Available -> {
                    sendUpdateStatus("available")
                    onUpdateAvailable(result.info)
                }
                UpdateManager.CheckResult.UpToDate -> sendUpdateStatus("latest")
                is UpdateManager.CheckResult.Failed -> sendUpdateStatus("failed")
            }
        }
    }

    private fun maybeCheckForUpdate() {
        val now = System.currentTimeMillis()
        if (updatePromptOpen || now - lastUpdateCheck < CHECK_INTERVAL_MS) return
        lastUpdateCheck = now
        lifecycleScope.launch {
            val result = UpdateManager.check()
            if (result is UpdateManager.CheckResult.Available && !isFinishing) onUpdateAvailable(result.info)
        }
    }

    private fun offerUpdate(info: UpdateManager.UpdateInfo) {
        updatePromptOpen = true
        AlertDialog.Builder(this)
            .setTitle("Update available")
            .setMessage("Bureau ${info.versionName} is ready to install. You have ${BuildConfig.VERSION_NAME}.")
            .setPositiveButton("Update") { _, _ -> runUpdate(info) }
            .setNegativeButton("Later", null)
            .setOnDismissListener { updatePromptOpen = false }
            .show()
    }

    private fun runUpdate(info: UpdateManager.UpdateInfo) {
        val pad = (24 * resources.displayMetrics.density).toInt()
        val bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            isIndeterminate = info.sizeBytes <= 0
        }
        val box = FrameLayout(this).apply {
            setPadding(pad, pad / 2, pad, 0)
            addView(bar)
        }
        val progress = AlertDialog.Builder(this)
            .setTitle("Downloading ${info.versionName}")
            .setView(box)
            .setCancelable(false)
            .show()

        lifecycleScope.launch {
            try {
                val apk = UpdateManager.download(this@MainActivity, info) { fraction ->
                    runOnUiThread { bar.progress = (fraction * 100).toInt() }
                }
                progress.dismiss()
                UpdateManager.install(this@MainActivity, apk)
            } catch (e: Exception) {
                progress.dismiss()
                Toast.makeText(
                    this@MainActivity,
                    "Update failed: ${e.message ?: "unknown error"}",
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    }
}
