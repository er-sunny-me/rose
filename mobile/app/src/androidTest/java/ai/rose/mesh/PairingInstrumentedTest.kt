package ai.rose.mesh

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** Instrumentation smoke tests (Phase 37 §91). Full UI flows land with the E2E harness. */
@RunWith(AndroidJUnit4::class)
class PairingInstrumentedTest {
    @Test
    fun packageName_isRoseMesh() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("ai.rose.mesh", ctx.packageName)
    }

    @Test
    fun notificationChannels_areCreated() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        ai.rose.mesh.notify.Notifications.ensureChannels(ctx)
        val mgr = ctx.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        listOf("tasks", "approvals", "system", "security").forEach { ch ->
            assert(mgr.getNotificationChannel(ch) != null)
        }
    }
}
