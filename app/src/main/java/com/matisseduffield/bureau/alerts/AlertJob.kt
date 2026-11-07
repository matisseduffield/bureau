package com.matisseduffield.bureau.alerts

import android.app.job.JobParameters
import android.app.job.JobService
import com.matisseduffield.bureau.rates.Rates
import java.math.BigDecimal
import java.math.MathContext
import java.text.NumberFormat
import kotlin.concurrent.thread

/**
 * The periodic alert check, against the same rates the page shows: live ones
 * from Coinbase, or daily ones if that fails. One round of fetching covers every
 * alert. A pair with no rate, or a rate too old
 * to mean anything, waits for the next check rather than firing.
 */
class AlertJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        thread {
            try {
                check()
            } finally {
                jobFinished(params, false)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters) = true

    private fun check() {
        val alerts = Alerts.load(this)
        if (alerts.isEmpty() || !Alerts.notificationsOn(this)) return
        val rates = Rates.Latest()
        val oldest = System.currentTimeMillis() - MAX_RATE_AGE_MS
        val fired = alerts.filter { alert ->
            val quote = rates.quote(alert.from, alert.to) ?: return@filter false
            if (quote.updatedAt < oldest) return@filter false
            val hit = if (alert.above) quote.rate >= alert.target else quote.rate <= alert.target
            if (!hit) return@filter false
            Alerts.notify(this, alert, format(quote.rate), format(alert.target))
            true
        }
        Alerts.removeAll(this, fired)
    }

    /** Same rounding as the page's rates: 2 decimals from 100 up, else 5 significant digits. */
    private fun format(n: Double): String {
        val nf = NumberFormat.getNumberInstance()
        if (n >= 100) return nf.apply { maximumFractionDigits = 2 }.format(n)
        val rounded = BigDecimal(n).round(MathContext(5)).stripTrailingZeros()
        nf.maximumFractionDigits = maxOf(0, rounded.scale())
        return nf.format(rounded)
    }

    private companion object {
        const val MAX_RATE_AGE_MS = 3 * 24 * 60 * 60 * 1000L
    }
}
