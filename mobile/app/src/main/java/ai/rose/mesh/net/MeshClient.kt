package ai.rose.mesh.net

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID

class MeshClient(
    private val scope: CoroutineScope,
    private val deviceId: String,
    private val listener: Listener
) {
    interface Listener {
        fun onStateChange(state: String)
        fun onMessage(json: String)
    }

    private var ws: WebSocket? = null
    private val client = OkHttpClient()
    private var serverUrl: String = ""
    private var agentId: String = ""
    private var deviceName: String = "Android Agent"
    private var isConnected = false

    fun connect(url: String, password: String, deviceName: String) {
        serverUrl = url
        agentId = password
        this.deviceName = deviceName
        
        val wsUrl = url.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/mesh/ws"
        val request = Request.Builder().url(wsUrl).header("Authorization", "Bearer $password").build()

        listener.onStateChange("Connecting...")
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                isConnected = true
                listener.onStateChange("Connected")
                
                // Send hello payload
                val hello = JSONObject().apply {
                    put("type", "hello")
                    put("v", 1)
                    put("nonce", UUID.randomUUID().toString())
                    put("ts", System.currentTimeMillis())
                    put("deviceId", deviceId)
                    put("protocolVersion", 1)
                    put("displayName", deviceName)
                    put("platform", "android")
                    put("capabilities", org.json.JSONArray(listOf("android_control")))
                }
                webSocket.send(hello.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                listener.onMessage(text)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                isConnected = false
                listener.onStateChange("Disconnected")
                ws = null
                reconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                isConnected = false
                listener.onStateChange("Error: ${t.message}")
                ws = null
                reconnect()
            }
        })
    }

    private fun reconnect() {
        if (serverUrl.isNotEmpty() && agentId.isNotEmpty()) {
            scope.launch {
                delay(3000)
                connect(serverUrl, agentId, deviceName)
            }
        }
    }

    fun send(payload: String) {
        ws?.send(payload)
    }

    /** GET /api/mesh — full registry with live status, for the Devices screen. */
    fun fetchMeshSummary(url: String, password: String, onResult: (String) -> Unit) {
        scope.launch(Dispatchers.IO) {
            val body = try {
                val req = Request.Builder()
                    .url("$url/api/mesh")
                    .header("Authorization", "Bearer $password")
                    .build()
                client.newCall(req).execute().use { it.body?.string() ?: "{}" }
            } catch (e: Exception) {
                JSONObject().put("error", e.message ?: "network error").toString()
            }
            withContext(Dispatchers.Main) { onResult(body) }
        }
    }

    /** True when the socket is currently open. */
    fun isConnected(): Boolean = isConnected

    fun disconnect() {
        serverUrl = ""
        agentId = ""
        ws?.close(1000, "User disconnected")
        ws = null
    }
}
