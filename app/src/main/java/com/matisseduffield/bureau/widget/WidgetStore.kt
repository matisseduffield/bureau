package com.matisseduffield.bureau.widget

import android.content.Context
import androidx.core.content.edit
import com.matisseduffield.bureau.rates.Rates

/**
 * The pair the widget shows. The app writes it whenever the page's pair,
 * amount, fee or rate changes; the widget refreshes the rate itself between
 * app visits.
 */
object WidgetStore {
    private const val PREFS = "widget"

    data class Pair(
        val from: String,
        val to: String,
        val fee: Double,
        /** Plain units of [to] per 1 [from], before any fee. */
        val rate: Double,
        /** When [rate] dates from: the fetch for a live rate, otherwise when its source published it. */
        val updatedAt: Long,
        /** The converter's amount in [from]; 1 shows the plain rate. */
        val amount: Double = 1.0,
        /** The page's home currency: the fee makes a price in it dearer, as on the page. */
        val home: String = "",
    ) {
        val effectiveRate: Double get() = if (to == home) rate / (1 - fee / 100) else rate * (1 - fee / 100)
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
            home = p.getString("home", null) ?: "",
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
            putString("home", pair.home)
        }
    }

    /**
     * Fetches the latest rate for the stored pair: live, or daily if Coinbase
     * fails. Blocking: call off the main thread. Keeps what it has if the answer
     * is older, and the stored time always stays the one that came with the rate.
     */
    fun refresh(context: Context): Boolean {
        val pair = load(context) ?: return false
        val quote = Rates.Latest().quote(pair.from, pair.to) ?: return false
        if (quote.updatedAt < pair.updatedAt) return false
        save(context, pair.copy(rate = quote.rate, updatedAt = quote.updatedAt))
        return true
    }
}
