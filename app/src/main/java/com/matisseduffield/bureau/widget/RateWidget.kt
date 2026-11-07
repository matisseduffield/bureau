package com.matisseduffield.bureau.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import com.matisseduffield.bureau.MainActivity
import com.matisseduffield.bureau.R
import java.math.BigDecimal
import java.math.MathContext
import com.matisseduffield.bureau.rates.Rates
import java.text.NumberFormat
import java.util.Currency
import kotlin.concurrent.thread

/**
 * Home-screen widget: the app's current pair and rate. Draws the stored rate
 * immediately, then fetches the latest one (every hour via updatePeriodMillis,
 * and whenever the app changes the pair). It always says what day the rate is from.
 */
class RateWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        render(context, manager, ids)
        val pending = goAsync()
        thread {
            try {
                if (WidgetStore.refresh(context)) render(context, manager, ids)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        fun updateAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, RateWidget::class.java))
            if (ids.isNotEmpty()) render(context, manager, ids)
        }

        private fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val views = RemoteViews(context.packageName, R.layout.widget_rate)
            val pair = WidgetStore.load(context)
            if (pair == null || pair.rate <= 0) {
                views.setTextViewText(R.id.widget_pair, context.getString(R.string.app_name))
                views.setTextViewText(R.id.widget_rate, "–")
                views.setTextViewText(R.id.widget_meta, context.getString(R.string.widget_setup))
            } else if (pair.amount == 1.0) {
                views.setTextViewText(R.id.widget_pair, "1 ${pair.from} in ${pair.to}")
                views.setTextViewText(R.id.widget_rate, formatRate(pair.effectiveRate))
                views.setTextViewText(R.id.widget_meta, meta(pair))
            } else {
                // The converter's amount, as last left in the app.
                views.setTextViewText(R.id.widget_pair, "${formatAmount(pair.amount)} ${pair.from} in ${pair.to}")
                views.setTextViewText(R.id.widget_rate, formatResult(pair.amount * pair.effectiveRate, pair.to))
                views.setTextViewText(R.id.widget_meta, meta(pair))
            }
            val open = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            views.setOnClickPendingIntent(R.id.widget_root, open)
            manager.updateAppWidget(ids, views)
        }

        private fun meta(pair: WidgetStore.Pair): String {
            val day = if (pair.updatedAt > 0) Rates.dayText(pair.updatedAt) else ""
            if (pair.fee <= 0) return if (day.isEmpty()) "" else "Rates from $day"
            val fee = "After ${NumberFormat.getNumberInstance().format(pair.fee)}% fee"
            return if (day.isEmpty()) fee else "$fee · $day"
        }

        /** The amount as typed: no padding, up to 8 decimals. */
        private fun formatAmount(n: Double): String =
            NumberFormat.getNumberInstance().apply { maximumFractionDigits = 8 }.format(n)

        /** A converted amount: the currency's own decimals, or 6 significant digits for a coin. */
        private fun formatResult(n: Double, code: String): String {
            val nf = NumberFormat.getNumberInstance()
            if (code in Rates.CRYPTO) {
                val rounded = BigDecimal(n).round(MathContext(6)).stripTrailingZeros()
                nf.maximumFractionDigits = maxOf(0, rounded.scale())
                return nf.format(rounded)
            }
            val digits = runCatching { Currency.getInstance(code).defaultFractionDigits }.getOrDefault(2).coerceAtLeast(0)
            nf.minimumFractionDigits = digits
            nf.maximumFractionDigits = digits
            return nf.format(n)
        }

        /** Same rounding as the page: 2 decimals from 100 up, else 5 significant digits. */
        private fun formatRate(rate: Double): String {
            val nf = NumberFormat.getNumberInstance()
            if (rate >= 100) {
                nf.maximumFractionDigits = 2
                return nf.format(rate)
            }
            val rounded = BigDecimal(rate).round(MathContext(5)).stripTrailingZeros()
            nf.maximumFractionDigits = maxOf(0, rounded.scale())
            return nf.format(rounded)
        }
    }
}
