package com.matisseduffield.bureau.rates

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * The page's two rate sources, for the parts of the app that run without it
 * (the widget and rate alerts). Rates are units per 1 USD. Blocking: call off
 * the main thread.
 */
object Rates {
    private const val LIVE_URL = "https://api.coinbase.com/v2/exchange-rates?currency=USD"
    private const val DAILY_URL = "https://open.er-api.com/v6/latest/USD"

    /** Coins the page offers (web/lib.js CRYPTO). */
    val CRYPTO = setOf("BTC", "ETH", "USDT", "XRP", "BNB", "SOL", "USDC", "DOGE", "ADA", "LTC")

    /** Coinbase's live rates, about a minute old. */
    fun live(): Map<String, Double>? =
        getJson(LIVE_URL)?.optJSONObject("data")?.optJSONObject("rates")?.toRates()

    /** Daily reference rates for national currencies; the yardstick for Coinbase outliers. */
    fun daily(): Map<String, Double>? =
        getJson(DAILY_URL)?.takeIf { it.optString("result") == "success" }?.optJSONObject("rates")?.toRates()

    /** Units of [to] per 1 [from], or null if either is missing. */
    fun cross(rates: Map<String, Double>, from: String, to: String): Double? {
        val a = if (from == "USD") 1.0 else rates[from] ?: return null
        val b = if (to == "USD") 1.0 else rates[to] ?: return null
        return if (a > 0 && b > 0) b / a else null
    }

    private fun JSONObject.toRates(): Map<String, Double> =
        keys().asSequence().mapNotNull { k -> optString(k).toDoubleOrNull()?.let { k to it } }.toMap()

    private fun getJson(url: String): JSONObject? {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 8_000
            readTimeout = 8_000
            useCaches = false
        }
        return try {
            if (conn.responseCode == 200) JSONObject(conn.inputStream.bufferedReader().readText()) else null
        } catch (_: Exception) {
            null
        } finally {
            conn.disconnect()
        }
    }
}
