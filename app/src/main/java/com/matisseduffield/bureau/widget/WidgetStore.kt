package com.matisseduffield.bureau.widget

import android.content.Context
import androidx.core.content.edit
import com.matisseduffield.bureau.rates.Rates
import kotlin.math.abs

/**
 * The pair the widget shows. The app writes it whenever the page's pair,
 * amount, fee or rate changes; the widget refreshes the rate itself between
 * app visits.
 */
object WidgetStore {
    private const val PREFS = "widget"
    private const val DAY_MS = 24 * 60 * 60 * 1000L

    data class Pair(
        val from: String,
        val to: String,
        val fee: Double,
        /** Mid-market units of [to] per 1 [from]. */
        val rate: Double,
        val updatedAt: Long,
        /** The converter's amount in [from]; 1 shows the plain rate. */
        val amount: Double = 1.0,
    ) {
        val effectiveRate: Double get() = rate * (1 - fee / 100)
    }

    fun load(context: Context): Pair? {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val from = p.getString("from", null) ?: return null
        val to = p.getString("to", null) ?: return null
        return Pair(
            from = from,
            to = to,
            fee = p.getFloat("fee", 0f).toDouble(),
            rate = p.getString("rate", null)?.toDoubleOrNull() ?: 0.0,
            updatedAt = p.getLong("updatedAt", 0L),
            amount = p.getString("amount", null)?.toDoubleOrNull()?.takeIf { it > 0 } ?: 1.0,
        )
    }

    fun save(context: Context, pair: Pair) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit {
            putString("from", pair.from)
            putString("to", pair.to)
            putFloat("fee", pair.fee.toFloat())
            putString("rate", pair.rate.toString())
            putLong("updatedAt", pair.updatedAt)
            putString("amount", pair.amount.toString())
        }
    }

    /**
     * Fetches a fresh live rate for the stored pair. Blocking: call off the
     * main thread. For currencies, a quote more than 10% away from a rate
     * stored in the last day is ignored, matching the page, which distrusts
     * Coinbase's outliers. Older rates aren't a fair yardstick (a currency
     * can really move 10% in weeks), so the widget never gets stuck on one.
     */
    fun refresh(context: Context): Boolean {
        val pair = load(context) ?: return false
        val fresh = Rates.live()?.let { Rates.cross(it, pair.from, pair.to) } ?: return false
        val check = pair.rate > 0 &&
            pair.from !in Rates.CRYPTO && pair.to !in Rates.CRYPTO &&
            System.currentTimeMillis() - pair.updatedAt < DAY_MS
        if (check && abs(fresh / pair.rate - 1) > 0.1) return false
        save(context, pair.copy(rate = fresh, updatedAt = System.currentTimeMillis()))
        return true
    }
}
