package ai.rose.mesh.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

/** Android notification channels (Phase 37 §34): Tasks / Approvals / System / Security. */
object Notifications {
    const val CH_TASKS = "tasks"
    const val CH_APPROVALS = "approvals"
    const val CH_SYSTEM = "system"
    const val CH_SECURITY = "security"

    fun ensureChannels(context: Context) {
        val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        listOf(
            NotificationChannel(CH_TASKS, "Tasks", NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(CH_APPROVALS, "Approvals", NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(CH_SYSTEM, "System", NotificationManager.IMPORTANCE_LOW),
            NotificationChannel(CH_SECURITY, "Security", NotificationManager.IMPORTANCE_HIGH),
        ).forEach(mgr::createNotificationChannel)
    }

    fun notifyTask(context: Context, title: String, body: String) = post(context, CH_TASKS, title, body)
    fun notifyApproval(context: Context, title: String, body: String) = post(context, CH_APPROVALS, title, body)

    private fun post(context: Context, channel: String, title: String, body: String) {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O) return
        val builder = androidx.core.app.NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body.take(180))
            .setAutoCancel(true)
        val intent = PendingIntent.getActivity(
            context, 0,
            Intent(context, Class.forName("ai.rose.mesh.MainActivity")),
            PendingIntent.FLAG_IMMUTABLE,
        )
        builder.setContentIntent(intent)
        val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // Stable per-channel ids keep approvals from overwriting tasks.
        mgr.notify(channel.hashCode(), builder.build())
    }
}
