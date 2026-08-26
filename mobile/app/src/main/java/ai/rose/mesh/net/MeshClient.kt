package ai.rose.mesh.net

import ai.rose.mesh.protocol.Challenge
import ai.rose.mesh.protocol.PairApproved
import ai.rose.mesh.protocol.RoseCodec
import ai.rose.mesh.protocol.Revoked
import ai.rose.mesh.security.SecretStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/** Connection states surfaced in the UI (Phase 37 §24). */
enum class ConnectionState { OFFLINE, CONNECTING, CONNECTED, RECONNECTING }

/**
 * Rose Mesh WebSocket client for Android.
 *
 * - pairing: connect with `?pair=<token>` → receive one-time deviceSecret
 * - reconnect: bounded exponential backoff (1s,2s,4s… capped 60s) — never an
 *   infinite aggressive loop (Phase 37 §25)
 */
class MeshClient(
    private val scope: CoroutineScope,
    private val store: SecretStore,
    private val listener: Listener,
) {
    interface Listener {
        fun onState(state: ConnectionState)
        fun onMessage(json: String)
        fun onPaired(agentId: String)
    }

    private val client = OkHttpClient()
    private var ws: WebSocket? = null
    private var host: String = ""
    private var deviceId: String = UUID.randomUUID().toString()
    var agentId: String? = null
        private set

    private val attempts = AtomicInteger(0)

    /** QR payload form: rose-mesh://pair?host=ip:port&token=... */
    fun pairFromQr(qr: String, displayName: String) {
        val uri = android.net.Uri.parse(qr.replaceFirst("rose-mesh://", "http://"))
        val hostPort = uri.getQueryParameter("host") ?: return
        val token = uri.getQueryParameter("token") ?: return
        this.host = hostPort
        connect("wss://$hostPort/mesh/ws?pair=${java.net.URLEncoder.encode(token, "utf-8")}", displayName)
    }

    /** Connect to a server URL from Settings (host:port or full http URL). */
    fun connectTo(serverUrl: String, displayName: String) {
        val cleaned = serverUrl.trim().removeSuffix("/")
        val hostPort = cleaned
            .removePrefix("https://")
            .removePrefix("http://")
            .substringBefore('/')
        this.host = hostPort
        val scheme = if (cleaned.startsWith("https://")) "wss" else "ws"
        connect("$scheme://$hostPort/mesh/ws?token=mesh.$deviceId", displayName)
    }

    fun reconnect(displayName: String) {
        if (host.isEmpty()) return
        connect("wss://$host/mesh/ws?token=mesh.$deviceId", displayName)
    }

    private fun connect(url: String, displayName: String) {
        listener.onState(if (attempts.get() == 0) ConnectionState.CONNECTING else ConnectionState.RECONNECTING)
        val req = Request.Builder().url(url).build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                val hello = buildString {
                    append("{\"type\":\"hello\",\"v\":1,\"nonce\":\"${newNonce()}\",\"ts\":${System.currentTimeMillis()},")
                    append("\"deviceId\":\"$deviceId\",\"displayName\":\"${jsonEscape(displayName)}\",")
                    append("\"platform\":\"android\",\"runtimeVersion\":\"1.0.0\",\"protocolVersion\":1,")
                    append("\"capabilities\":[\"camera\",\"microphone\",\"notifications\"]}")
                }
                webSocket.send(hello)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                listener.onMessage(text)
                when {
                    text.contains("\"mobile.pair.approved\"") -> {
                        val approved = RoseCodec.json.decodeFromString(PairApproved.serializer(), text)
                        store.put(KEY_SECRET, approved.deviceSecret)
                        store.put(KEY_AGENT_ID, approved.agentId)
                        agentId = approved.agentId
                        attempts.set(0)
                        listener.onState(ConnectionState.CONNECTED)
                        listener.onPaired(approved.agentId)
                    }
                    text.contains("\"challenge\"") && !text.contains("response") -> {
                        val challenge = RoseCodec.json.decodeFromString(Challenge.serializer(), text)
                        val secret = store.get(KEY_SECRET) ?: return
                        val response = sha256("${challenge.challenge}:${sha256(secret)}")
                        webSocket.send(
                            "{\"type\":\"challenge.response\",\"v\":1,\"nonce\":\"${newNonce()}\"," +
                                "\"ts\":${System.currentTimeMillis()},\"response\":\"$response\"," +
                                "\"capabilities\":[\"camera\",\"microphone\",\"notifications\"]}",
                        )
                    }
                    text.contains("\"agent.revoked\"") -> {
                        store.delete(KEY_SECRET)
                        store.delete(KEY_AGENT_ID)
                        listener.onState(ConnectionState.OFFLINE)
                    }
                    text.contains("\"mobile.pair.rejected\"") -> {
                        listener.onState(ConnectionState.OFFLINE)
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                scheduleReconnect(displayName)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (code == 4003) { // revoked — do not auto-retry pairing
                    listener.onState(ConnectionState.OFFLINE)
                    return
                }
                scheduleReconnect(displayName)
            }
        })
    }

    private fun scheduleReconnect(displayName: String) {
        listener.onState(ConnectionState.RECONNECTING)
        val attempt = attempts.incrementAndGet()
        if (attempt > 10) { listener.onState(ConnectionState.OFFLINE); return } // bounded: give up after 10 tries
        val backoffMs = minOf(60_000L, 1000L shl (attempt - 1).coerceAtMost(6)) // 1s..64s
        scope.launch {
            delay(backoffMs)
            reconnect(displayName)
        }
    }

    fun send(json: String): Boolean = ws?.send(json) ?: false

    fun close() {
        attempts.set(Int.MAX_VALUE / 2) // stop backoff loop
        ws?.close(1000, "bye")
        listener.onState(ConnectionState.OFFLINE)
    }

    private fun newNonce(): String = UUID.randomUUID().toString().replace("-", "").take(16)

    private fun jsonEscape(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"")

    companion object {
        const val KEY_SECRET = "mesh.deviceSecret"
        const val KEY_AGENT_ID = "mesh.agentId"

        /** Mirrors DeviceRegistry.clientResponse on the server. */
        fun sha256(input: String): String =
            MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
    }
}
