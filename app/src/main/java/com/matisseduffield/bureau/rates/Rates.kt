package com.matisseduffield.bureau.rates

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.Locale
import kotlin.math.abs

/**
 * The page's rate sources, for the parts of the app that run without it (the
 * widget and rate alerts). Coinbase's live rates come first, and a currency's
 * quote is checked against ExchangeRate-API's daily rate, as the page does.
 * Without Coinbase, currencies come from ExchangeRate-API, then the daily file,
 * and coins from the file. Rates are units per 1 USD, and each one keeps its time.
 */
object Rates {
    private const val LIVE_URL = "https://api.coinbase.com/v2/exchange-rates?currency=USD"
    private const val DAILY_URL = "https://open.er-api.com/v6/latest/USD"
    private val FILE_URLS = listOf(
        "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
        "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json",
    )
    private const val DAY_MS = 24 * 60 * 60 * 1000L
    private const val FILE_FRESH_MS = 2 * DAY_MS
    private const val MAX_LIVE_GAP = 0.1

    /** Coins the page offers (web/lib.js CRYPTO). */
    val CRYPTO = setOf("BTC", "ETH", "USDT", "XRP", "BNB", "SOL", "USDC", "DOGE", "ADA", "LTC")

    /** Far from ExchangeRate-API's figures in the file, so a fallback has no rate for them (web/lib.js FILE_SKIP). */
    private val FILE_SKIP = setOf("SDG", "SYP", "ZWL")

    private class Snapshot(val rates: Map<String, Double>, val updatedAt: Long)

    /** Units of the second currency per 1 of the first, and when the older side was published. */
    class Quote(val rate: Double, val updatedAt: Long)

    /** One round of fetching. Blocking, so use it off the main thread. Each source is read once, when first needed. */
    class Latest {
        private val live by lazy { fetchLive() }
        private val daily by lazy { fetchDaily() }
        private val file by lazy { fetchFile() }

        /** The rate for a pair, or null if either side has none. */
        fun quote(from: String, to: String): Quote? {
            val a = side(from) ?: return null
            val b = side(to) ?: return null
            return Quote(b.first / a.first, minOf(a.second, b.second))
        }

        private fun side(code: String): Pair<Double, Long>? {
            if (code == "USD") return 1.0 to Long.MAX_VALUE
            live?.let { now ->
                val rate = now.rates[code]?.takeIf { it > 0 }
                if (rate != null && trusted(code, rate)) return rate to now.updatedAt
            }
            val source = when {
                code in CRYPTO -> file
                else -> daily ?: file?.takeIf { code !in FILE_SKIP }
            } ?: return null
            val rate = source.rates[code]?.takeIf { it > 0 } ?: return null
            return rate to source.updatedAt
        }

        /** A currency's live quote stands unless it's over 10% from the daily rate (web/lib.js mergeRates). */
        private fun trusted(code: String, rate: Double): Boolean {
            if (code in CRYPTO) return true
            val reference = (daily ?: file?.takeIf { code !in FILE_SKIP })?.rates?.get(code)?.takeIf { it > 0 } ?: return true
            return abs(rate / reference - 1) <= MAX_LIVE_GAP
        }
    }

    /** Coinbase's live rates. They carry no time of their own, so they date from now. */
    private fun fetchLive(): Snapshot? {
        val rates = getJson(LIVE_URL)?.optJSONObject("data")?.optJSONObject("rates")?.toRates() ?: return null
        return Snapshot(rates, System.currentTimeMillis()).takeIf { rates.containsKey("EUR") }
    }

    private fun fetchDaily(): Snapshot? {
        val json = getJson(DAILY_URL)?.takeIf { it.optString("result") == "success" } ?: return null
        val at = json.optLong("time_last_update_unix") * 1000
        val rates = json.optJSONObject("rates")?.toRates() ?: return null
        return Snapshot(rates, at).takeIf { at > 0 && rates.containsKey("EUR") }
    }

    /** The first mirror answers unless it's serving an old file; then the newest wins. */
    private fun fetchFile(): Snapshot? {
        var best: Snapshot? = null
        for (url in FILE_URLS) {
            val file = getJson(url)?.toFile()
            if (file != null && file.updatedAt > (best?.updatedAt ?: 0)) best = file
            if (best != null && System.currentTimeMillis() - best.updatedAt < FILE_FRESH_MS) break
        }
        return best
    }

    /** The file has lowercase codes and a date rather than a time. */
    private fun JSONObject.toFile(): Snapshot? {
        val rates = optJSONObject("usd")?.toRates()?.mapKeys { it.key.uppercase(Locale.ROOT) } ?: return null
        val at = runCatching {
            LocalDate.parse(optString("date")).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        }.getOrNull() ?: return null
        return Snapshot(rates, at).takeIf { rates.containsKey("EUR") }
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
