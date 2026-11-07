package com.matisseduffield.bureau.alerts

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.edit
import com.matisseduffield.bureau.MainActivity
import com.matisseduffield.bureau.R
import org.json.JSONArray
import org.json.JSONObject

/**
 * Rate alerts: "tell me when 1 EUR reaches 0.85 GBP". At most one per pair,
 * kept in SharedPreferences and checked by [AlertJob] about every 30 minutes
 * while any exist. An alert fires once, as a notification, then is removed.
 */
object Alerts {
    private const val PREFS = "alerts"
    private const val JOB_ID = 1
    private const val CHANNEL = "rate_alerts"
    private const val CHECK_EVERY_MS = 30 * 60 * 1000L
    const val EXTRA_FROM = "alert_from"
    const val EXTRA_TO = "alert_to"

    /** Fires when the plain rate is at or past [target], going the way [above] says. */
    data class Alert(val from: String, val to: String, val target: Double, val above: Boolean)

    fun load(context: Context): List<Alert> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("list", null) ?: return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                Alert(o.getString("from"), o.getString("to"), o.getDouble("target"), o.getBoolean("above"))
            }
        }.getOrDefault(emptyList())
    }

    private fun save(context: Context, list: List<Alert>) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit { putString("list", toJson(list).toString()) }
        schedule(context, list.isNotEmpty())
    }

    fun toJson(list: List<Alert>): JSONArray = JSONArray(list.map {
        JSONObject().put("from", it.from).put("to", it.to).put("target", it.target).put("above", it.above)
    })

    fun set(context: Context, alert: Alert) =
        save(context, load(context).filterNot { it.from == alert.from && it.to == alert.to } + alert)

    fun remove(context: Context, from: String, to: String) =
        save(context, load(context).filterNot { it.from == from && it.to == to })

    fun removeAll(context: Context, fired: Collection<Alert>) {
        if (fired.isNotEmpty()) save(context, load(context) - fired.toSet())
    }

    fun notificationsOn(context: Context) = NotificationManagerCompat.from(context).areNotificationsEnabled()

    /** Brings a job scheduled by an older version, at its old interval, up to date. */
    fun reschedule(context: Context) = schedule(context, load(context).isNotEmpty())

    /** The periodic check runs only while there are alerts, and only with a network. */
    private fun schedule(context: Context, on: Boolean) {
        val jobs = context.getSystemService(JobScheduler::class.java)
        if (!on) return jobs.cancel(JOB_ID)
        if (jobs.getPendingJob(JOB_ID)?.intervalMillis == CHECK_EVERY_MS) return
        // A refused job must never take the app down with it.
        runCatching {
            jobs.schedule(
                JobInfo.Builder(JOB_ID, ComponentName(context, AlertJob::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(CHECK_EVERY_MS)
                    .setPersisted(true)
                    .build(),
            )
        }
    }

    fun notify(context: Context, alert: Alert, rate: String, target: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.alerts_channel), NotificationManager.IMPORTANCE_DEFAULT),
        )
        val open = PendingIntent.getActivity(
            context,
            "${alert.from}${alert.to}".hashCode(),
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_FROM, alert.from)
                .putExtra(EXTRA_TO, alert.to),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val way = if (alert.above) "rose above" else "fell below"
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_alert)
            .setContentTitle("1 ${alert.from} = $rate ${alert.to}")
            .setContentText("${alert.from} → ${alert.to} $way your $target alert")
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { nm.notify("${alert.from}${alert.to}".hashCode(), notification) }
    }
}
