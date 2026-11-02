package com.matisseduffield.bureau.alerts

import android.app.job.JobParameters
import android.app.job.JobService
import com.matisseduffield.bureau.rates.Rates
import java.math.BigDecimal
import java.math.MathContext
import java.text.NumberFormat
import kotlin.concurrent.thread
import kotlin.math.abs

/**
 * The periodic alert check. One live fetch covers every alert; a national
 * currency's alert is confirmed against the daily reference first, so a
 * Coinbase outlier can't set it off.
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
        val live = Rates.live() ?: return
        val daily by lazy { Rates.daily() }
        val fired = alerts.filter { alert ->
            val rate = Rates.cross(live, alert.from, alert.to) ?: return@filter false
            val hit = if (alert.above) rate >= alert.target else rate <= alert.target
            if (!hit) return@filter false
            val fiat = alert.from !in Rates.CRYPTO && alert.to !in Rates.CRYPTO
            if (fiat) {
                val ref = daily?.let { Rates.cross(it, alert.from, alert.to) }
                if (ref != null && abs(rate / ref - 1) > 0.1) return@filter false
            }
            Alerts.notify(this, alert, format(rate), format(alert.target))
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
}
