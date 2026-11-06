package com.matisseduffield.bureau

import android.Manifest
import android.annotation.SuppressLint
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
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import com.matisseduffield.bureau.alerts.Alerts
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.matisseduffield.bureau.updates.AppUpdates
import com.matisseduffield.bureau.widget.RateWidget
import com.matisseduffield.bureau.widget.WidgetStore
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

        // The page's bureauBack() closes the fee menu or the currency picker,
        // whichever is open, and says whether it closed anything.
        const val CLOSE_PICKER_JS =
            "(() => typeof bureauBack === 'function' && bureauBack() === true)()"
    }

    private lateinit var web: WebView
    private val updates = AppUpdates(this, ::send)
    private var page: JavaScriptReplyProxy? = null
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

        updates.start(firstCreate = savedInstanceState == null)
    }

    // Out of sight, the page's timers and rate polling stop entirely; they
    // resume (and refresh stale rates) as soon as the app is back.
    override fun onResume() {
        super.onResume()
        web.onResume()
        web.resumeTimers()
        updates.onResume()
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
                send(JSONObject().put("type", "info").put("version", BuildConfig.VERSION_NAME).put("updates", BuildConfig.SELF_UPDATER))
                updates.onPageReady()
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
            "checkUpdate" -> updates.checkNow()
            "installUpdate" -> updates.installPending()
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

}
