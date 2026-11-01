package com.matisseduffield.bureau.updates

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import com.matisseduffield.bureau.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Self-updater. The source repo is private, so each release build also
 * publishes the APK and a small latest.json to the public bureau-releases
 * repo; this reads that file, downloads the APK, checks its SHA-256, and
 * hands it to [PackageInstaller]. The OS verifies the signature matches the
 * installed app, so data is preserved and nothing unsigned can install.
 */
object UpdateManager {
    private const val LATEST_URL =
        "https://raw.githubusercontent.com/matisseduffield/bureau-releases/main/latest.json"

    data class UpdateInfo(
        val versionCode: Int,
        val versionName: String,
        val apkUrl: String,
        val sizeBytes: Long,
        val sha256: String,
        /** Short "what's new" lines from the release's tag message. */
        val notes: List<String> = emptyList(),
    )

    /** Outcome of a check — distinguishes "up to date" from "couldn't check". */
    sealed interface CheckResult {
        data class Available(val info: UpdateInfo) : CheckResult
        data object UpToDate : CheckResult
        data class Failed(val message: String) : CheckResult
    }

    /** Terminal install-failure message from [UpdateInstallReceiver], shown by the activity. */
    val installError = MutableStateFlow<String?>(null)

    suspend fun check(): CheckResult = withContext(Dispatchers.IO) {
        // The query string sidesteps raw.githubusercontent.com's 5-minute cache.
        val url = URL("$LATEST_URL?t=${System.currentTimeMillis()}")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 15_000
            useCaches = false
        }
        try {
            val code = conn.responseCode
            if (code != 200) return@withContext CheckResult.Failed("Couldn't reach GitHub (HTTP $code)")
            val root = JSONObject(conn.inputStream.bufferedReader().readText())
            val info = UpdateInfo(
                versionCode = root.getInt("versionCode"),
                versionName = root.getString("versionName"),
                apkUrl = root.getString("apk"),
                sizeBytes = root.optLong("size", -1L),
                sha256 = root.getString("sha256").lowercase(),
                notes = root.optJSONArray("notes")?.let { arr ->
                    (0 until arr.length()).mapNotNull { arr.optString(it).takeIf(String::isNotBlank) }
                } ?: emptyList(),
            )
            if (info.versionCode > BuildConfig.VERSION_CODE) CheckResult.Available(info) else CheckResult.UpToDate
        } catch (e: Exception) {
            CheckResult.Failed(e.message ?: "Update check failed")
        } finally {
            conn.disconnect()
        }
    }

    /** Streams the APK to app cache, reporting progress 0..1, then verifies its hash. */
    suspend fun download(
        context: Context,
        info: UpdateInfo,
        onProgress: (Float) -> Unit,
    ): File = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val out = File(dir, "update-${info.versionName}.apk")
        val conn = (URL(info.apkUrl).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 30_000
            instanceFollowRedirects = true
        }
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            if (conn.responseCode != 200) error("Download failed: HTTP ${conn.responseCode}")
            val total = if (info.sizeBytes > 0) info.sizeBytes else conn.contentLengthLong
            conn.inputStream.use { input ->
                out.outputStream().use { sink ->
                    val buf = ByteArray(64 * 1024)
                    var read = input.read(buf)
                    var done = 0L
                    while (read >= 0) {
                        sink.write(buf, 0, read)
                        digest.update(buf, 0, read)
                        done += read
                        if (total > 0) onProgress((done.toFloat() / total).coerceIn(0f, 1f))
                        read = input.read(buf)
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
        val actual = digest.digest().joinToString("") { "%02x".format(it) }
        if (actual != info.sha256) {
            out.delete()
            error("Downloaded file didn't match the published checksum")
        }
        out
    }

    /**
     * Commits the APK through PackageInstaller on IO; Android shows the confirm
     * UI and enforces the signature match. Abandons any stale sessions first and
     * cleans up on failure so retries never accumulate orphaned sessions.
     */
    suspend fun install(context: Context, apk: File): Unit = withContext(Dispatchers.IO) {
        val installer = context.packageManager.packageInstaller

        // Reject an APK that isn't actually this app before we ever prompt.
        val pkgInfo = context.packageManager.getPackageArchiveInfo(apk.absolutePath, 0)
        require(pkgInfo?.packageName == BuildConfig.APPLICATION_ID) {
            "Downloaded APK is not ${BuildConfig.APPLICATION_ID}"
        }

        installer.mySessions.forEach { runCatching { installer.abandonSession(it.sessionId) } }

        val params = PackageInstaller.SessionParams(
            PackageInstaller.SessionParams.MODE_FULL_INSTALL,
        ).apply {
            setAppPackageName(BuildConfig.APPLICATION_ID)
        }
        val sessionId = installer.createSession(params)
        try {
            installer.openSession(sessionId).use { session ->
                apk.inputStream().use { input ->
                    session.openWrite("update.apk", 0, apk.length()).use { sink ->
                        input.copyTo(sink)
                        session.fsync(sink)
                    }
                }
                val statusIntent = Intent(context, UpdateInstallReceiver::class.java)
                    .setAction(UpdateInstallReceiver.ACTION_INSTALL_STATUS)
                    .setPackage(context.packageName)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                val pending = PendingIntent.getBroadcast(context, sessionId, statusIntent, flags)
                session.commit(pending.intentSender)
            }
        } catch (e: Exception) {
            runCatching { installer.abandonSession(sessionId) }
            throw e
        }
    }
}
