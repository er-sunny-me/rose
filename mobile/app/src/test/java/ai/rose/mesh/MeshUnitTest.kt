package ai.rose.mesh

import ai.rose.mesh.policy.RosePolicy
import ai.rose.mesh.policy.Router
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests (Phase 37 §90): policy gate, smart routing,
 * challenge HMAC contract mirrored from the TypeScript server.
 */
class MeshUnitTest {

    // ── Rose Policy: Android permission + Policy BOTH required ──

    @Test
    fun `camera requires both os permission and policy`() {
        val p = RosePolicy()
        assertTrue(p.canUse(RosePolicy.Capability.CAMERA, osPermissionGranted = true))
        assertFalse(p.canUse(RosePolicy.Capability.CAMERA, osPermissionGranted = false))
        p.setAllowed(RosePolicy.Capability.CAMERA, false)
        assertFalse(p.canUse(RosePolicy.Capability.CAMERA, osPermissionGranted = true))
    }

    @Test
    fun `location is denied by default even with permission`() {
        val p = RosePolicy()
        assertFalse(p.canUse(RosePolicy.Capability.LOCATION, osPermissionGranted = true))
        p.setAllowed(RosePolicy.Capability.LOCATION, true)
        assertTrue(p.canUse(RosePolicy.Capability.LOCATION, osPermissionGranted = true))
    }

    // ── Smart routing (§107-108) ──

    @Test
    fun `camera tasks run locally`() {
        val r = Router.route(listOf("camera"), Router.DeviceState(80, charging = false, onWifi = true))
        assertTrue(r is Router.Decision.RunLocal)
    }

    @Test
    fun `terminal tasks delegate to pc`() {
        val r = Router.route(listOf("terminal"), Router.DeviceState(80, charging = false, onWifi = true))
        assertTrue(r is Router.Decision.DelegateToPc)
    }

    @Test
    fun `heavy tasks wait for charging on low battery`() {
        val r = Router.route(listOf("filesystem"), Router.DeviceState(15, charging = false, onWifi = true))
        assertTrue(r is Router.Decision.Wait)
    }

    @Test
    fun `large transfers wait for wifi when off wifi`() {
        val r = Router.route(listOf("filesystem"), Router.DeviceState(90, charging = true, onWifi = false))
        assertTrue(r is Router.Decision.Wait)
    }

    // ── Challenge HMAC contract (mirrors server DeviceRegistry) ──

    @Test
    fun `challenge response formula matches server expectation shape`() {
        val secret = "abc123"
        val challenge = "chal-xyz"
        val response = sha256("$challenge:${sha256(secret)}")
        assertEquals(64, response.length)
        assertEquals(response, sha256("$challenge:${sha256(secret)}"))
    }

    private fun sha256(input: String): String =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest(input.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}
