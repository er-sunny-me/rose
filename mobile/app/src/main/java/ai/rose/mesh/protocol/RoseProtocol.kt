package ai.rose.mesh.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Rose Agent Mesh Protocol v1 — Kotlin mirror of
 * /shared/protocol/rose-mesh-protocol.json.
 *
 * Invariants mirrored from the TypeScript gateway:
 *  - clients never self-assign agentId/from/to (server stamps them)
 *  - every envelope carries a fresh nonce + sender timestamp
 *  - protocolVersion must equal the server's or the socket is closed
 */
const val PROTOCOL_VERSION = 1

@Serializable
data class Envelope(
    val type: String,
    val v: Int = PROTOCOL_VERSION,
    val nonce: String,
    val ts: Long,
    val from: String? = null,   // stamped by the SERVER
    val to: String? = null,
) {
    companion object {
        fun create(type: String, nonce: String = RoseCodec.newNonce()): Envelope =
            Envelope(type = type, nonce = nonce, ts = System.currentTimeMillis())
    }
}

// ── hello / pairing ─────────────────────────────────────────

@Serializable
data class Hello(
    @SerialName("type") val type: String = "hello",
    val v: Int = PROTOCOL_VERSION,
    val nonce: String,
    val ts: Long,
    val deviceId: String,
    val displayName: String,
    val platform: String,
    val runtimeVersion: String,
    val protocolVersion: Int = PROTOCOL_VERSION,
    val capabilities: List<String>,
    val pairToken: String? = null,      // only during first pairing
    val resourceState: Map<String, Double> = emptyMap(),
)

@Serializable
data class Challenge(val type: String, val challenge: String)

@Serializable
data class ChallengeResponse(
    val type: String = "challenge.response",
    val v: Int = PROTOCOL_VERSION,
    val nonce: String,
    val ts: Long,
    val response: String,
    val capabilities: List<String>,
)

@Serializable
data class PairApproved(
    val type: String,
    val agentId: String,
    /** One-time secret over TLS; stored in Android Keystore-backed store. */
    val deviceSecret: String,
    val trust: String,
)

@Serializable
data class PairRejected(val type: String, val reason: String)

@Serializable
data class Revoked(val type: String, val reason: String? = null)

@Serializable
data class Welcome(val type: String, val agentId: String, val trust: String, val serverTime: Long)

// ── presence / capabilities / tasks ─────────────────────────

@Serializable
data class PresenceUpdate(
    val type: String = "agent.presence",
    val v: Int = PROTOCOL_VERSION,
    val nonce: String,
    val ts: Long,
    val status: String,                 // online | busy | degraded | offline
)

@Serializable
data class CapabilitiesUpdate(
    val type: String = "agent.capabilities",
    val v: Int = PROTOCOL_VERSION,
    val nonce: String,
    val ts: Long,
    val capabilities: List<String>,
    val resourceState: Map<String, Double> = emptyMap(),
)

@Serializable
data class TaskDelegate(
    val type: String,
    val taskId: String,
    val goal: String,
    val originAgent: String? = null,
    val ownerAgent: String? = null,
    val delegatedAgent: String? = null,
    @SerialName("requiredCapabilities") val requiredCapabilities: List<String> = emptyList(),
)

@Serializable
data class TaskProgress(
    val type: String = "agent.task.progress",
    val v: Int = PROTOCOL_VERSION,
    val nonce: String,
    val ts: Long,
    val to: String,
    val taskId: String,
    val pct: Double,
    val step: String,
)

@Serializable
data class TaskResult(
    val type: String = "agent.task.result",
    val v: Int = PROTOCOL_VERSION,
    val nonce: String,
    val ts: Long,
    val to: String? = null,
    val taskId: String,
    /** completed | failed | unknown (unknown → reconcile, never blind-retry) */
    val state: String,
    val summary: String = "",
)

@Serializable
data class ApprovalRequest(
    val type: String,
    val approvalId: String,
    val command: String,
    val workspace: String? = null,
    val risk: String? = null,
)

@Serializable
data class ApprovalResponse(
    val type: String = "agent.approval.response",
    val v: Int = PROTOCOL_VERSION,
    val nonce: String,
    val ts: Long,
    val to: String,
    val approvalId: String,
    val allow: Boolean,
)

/** Shared codec. */
object RoseCodec {
    val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        classDiscriminator = "type"
    }

    fun newNonce(): String =
        java.util.UUID.randomUUID().toString().replace("-", "").take(16)
}
