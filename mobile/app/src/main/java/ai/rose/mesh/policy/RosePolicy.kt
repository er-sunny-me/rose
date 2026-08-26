package ai.rose.mesh.policy

/**
 * Rose Policy gate (Phase 37 §19):
 *
 *     Android permission granted  +  Rose Policy allows  →  capability usable
 *
 * Android permission ALONE is never sufficient. `grantedPermissions` comes
 * from the OS; the policy table is user/pairing controlled and survives app
 * restarts.
 */
class RosePolicy(
    private val allowed: MutableMap<Capability, Boolean> = defaultTable(),
) {
    enum class Capability { CAMERA, MICROPHONE, NOTIFICATIONS, LOCATION, CLIPBOARD, LOCAL_FILES, REMOTE_DELEGATION }

    /** True only when BOTH the OS permission is granted AND policy allows. */
    fun canUse(capability: Capability, osPermissionGranted: Boolean): Boolean =
        osPermissionGranted && (allowed[capability] ?: false)

    fun setAllowed(capability: Capability, allow: Boolean) {
        allowed[capability] = allow
    }

    fun snapshot(): Map<Capability, Boolean> = allowed.toMap()

    companion object {
        /** Conservative defaults: mobile-native capabilities on, sensitive ones off. */
        fun defaultTable(): MutableMap<Capability, Boolean> = mutableMapOf(
            Capability.CAMERA to true,
            Capability.MICROPHONE to true,
            Capability.NOTIFICATIONS to true,
            Capability.LOCAL_FILES to true,
            Capability.LOCATION to false,
            Capability.CLIPBOARD to false,
            Capability.REMOTE_DELEGATION to true,
        )
    }
}

/**
 * Smart routing hint (Phase 37 §107-108): decide local vs PC delegation from
 * required capabilities + device constraints. Pure function → unit-testable.
 */
object Router {

    data class DeviceState(
        val batteryPct: Int,
        val charging: Boolean,
        val onWifi: Boolean,
    )

    sealed class Decision {
        data class RunLocal(val reason: String) : Decision()
        data class DelegateToPc(val reason: String) : Decision()
        data class Wait(val reason: String) : Decision()
    }

    private val MOBILE_NATIVE = setOf("camera", "microphone", "notifications", "location")

    fun route(requiredCapabilities: List<String>, device: DeviceState): Decision {
        val native = requiredCapabilities.filter { it in MOBILE_NATIVE }
        if (native.isNotEmpty()) return Decision.RunLocal("mobile-native capability: ${native.joinToString()}")
        if (requiredCapabilities.any { it in setOf("terminal", "filesystem", "browser", "gpu") }) {
            if (device.batteryPct < 20 && !device.charging) {
                return Decision.Wait("battery low (${device.batteryPct}%) — task queued for charging")
            }
            if (!device.onWifi && (requiredCapabilities.contains("filesystem"))) {
                return Decision.Wait("large transfer needs Wi-Fi")
            }
            return Decision.DelegateToPc("heavy capability requires PC")
        }
        return Decision.RunLocal("no special requirements")
    }
}
