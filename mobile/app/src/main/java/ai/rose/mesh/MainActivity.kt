package ai.rose.mesh

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import ai.rose.mesh.agent.MobileAgentRuntime
import ai.rose.mesh.ai.GeminiClient
import ai.rose.mesh.memory.MemoryStore
import ai.rose.mesh.net.ConnectionState
import ai.rose.mesh.net.MeshClient
import ai.rose.mesh.policy.RosePolicy
import ai.rose.mesh.policy.Router
import ai.rose.mesh.security.KeystoreSecretStore
import ai.rose.mesh.settings.SettingsStore
import ai.rose.mesh.ui.AgentRow
import ai.rose.mesh.ui.AgentsScreen
import ai.rose.mesh.ui.ChatLine
import ai.rose.mesh.ui.ChatScreen
import ai.rose.mesh.ui.RoseTheme
import ai.rose.mesh.ui.SettingsScreen
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class RoseApp : android.app.Application() {
    override fun onCreate() {
        super.onCreate()
        // Android notification channels (Phase 37 §34).
        ai.rose.mesh.notify.Notifications.ensureChannels(this)
    }
}

/**
 * Single-activity Compose app wiring the REAL agent stack:
 *
 *   SettingsStore (server URL, name) ──▶ MeshClient ──▶ gateway /mesh/ws
 *   KeystoreSecretStore (Gemini key) ──▶ GeminiClient ──▶ on-device replies
 *   MemoryStore + Router + Policy   ──▶ MobileAgentRuntime
 *
 * QR pairing: Settings → "Scan QR" → zxing camera scanner reads the
 * rose-mesh://pair payload → auto-connects.
 */
class MainActivity : ComponentActivity() {

    private val scope = MainScope()

    private lateinit var settingsStore: SettingsStore
    private lateinit var secretStore: KeystoreSecretStore
    private lateinit var gemini: GeminiClient
    private lateinit var memory: MemoryStore
    private lateinit var policy: RosePolicy
    private lateinit var runtime: MobileAgentRuntime
    private lateinit var client: MeshClient
    private var liveClient: ai.rose.mesh.ai.GeminiLiveClient? = null

    private val state = MutableStateFlow(ConnectionState.OFFLINE)
    private val chat = MutableStateFlow(listOf(ChatLine("rose", "Namaste! Pair with your PC to unlock the full mesh.")))
    private val agentsPayload = MutableStateFlow("[]")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)

        settingsStore = SettingsStore(this)
        secretStore = KeystoreSecretStore(this)
        gemini = GeminiClient(secretStore)
        memory = MemoryStore(this)
        policy = RosePolicy()
        runtime = MobileAgentRuntime(scope, gemini, memory, policy).also { rt ->
            rt.onChatLine = { role, text -> addChat(role, text) }
            rt.meshProvider = { if (::client.isInitialized && state.value == ConnectionState.CONNECTED) client else null }
        }

        client = MeshClient(scope, secretStore, object : MeshClient.Listener {
            override fun onState(s: ConnectionState) { state.value = s }
            override fun onMessage(json: String) {
                agentsPayload.value = json
                runtime.handleInbound(json, client, chatCallback())
                if (json.contains("\"agent.task.result\"")) {
                    addChat("pc", "✅ PC finished a delegated task.")
                    ai.rose.mesh.notify.Notifications.notifyTask(this@MainActivity, "Rose", "Task finished")
                }
                if (json.contains("\"agent.approval.request\"")) {
                    addChat("sys", "⚠️ Approval requested by PC")
                    ai.rose.mesh.notify.Notifications.notifyApproval(this@MainActivity, "Approval required", "PC needs your approval")
                }
            }
            override fun onPaired(agentId: String) { addChat("rose", "🤝 Paired! agentId=$agentId") }
        })

        // Deep link from QR scan: rose-mesh://pair?host=...&token=...
        val qrLink = intent?.dataString
        scope.launch {
            val s = settingsStore.current()
            runtime.displayName = s.displayName
            when {
                !qrLink.isNullOrEmpty() && qrLink.startsWith("rose-mesh://pair") ->
                    client.pairFromQr(qrLink, s.displayName)
                s.autoConnect && s.serverUrl.isNotBlank() ->
                    client.connectTo(s.serverUrl, s.displayName)
            }
        }

        setContent { RoseTheme { AppRoot() } }
    }

    private fun addChat(role: String, text: String) {
        chat.value = chat.value + ChatLine(role, text)
    }

    @Composable
    private fun AppRoot() {
        val nav = rememberNavController()
        val status by state.collectAsStateWithLifecycle()
        val lines by chat.collectAsStateWithLifecycle()
        val settings by settingsStore.settings.collectAsStateWithLifecycle(
            initialValue = ai.rose.mesh.settings.RoseSettings("https://nexusbot.in", "My Phone", true),
        )
        val statusLabel = when (status) {
            ConnectionState.CONNECTED -> "Connected"
            ConnectionState.CONNECTING -> "Connecting"
            ConnectionState.RECONNECTING -> "Reconnecting"
            else -> "Offline"
        }

        val micPermissionLauncher = rememberLauncherForActivityResult(
            ActivityResultContracts.RequestPermission()
        ) { granted ->
            if (granted) {
                if (liveClient == null) {
                    val key = secretStore.get(GeminiClient.KEY_API)
                    if (key.isNullOrBlank()) {
                        addChat("sys", "⚠️ Set Gemini API key in Settings first.")
                        return@rememberLauncherForActivityResult
                    }
                    liveClient = ai.rose.mesh.ai.GeminiLiveClient(key).apply {
                        onStateChange = { active -> addChat("sys", if (active) "🎙️ Live Voice started..." else "🎙️ Live Voice stopped.") }
                        onError = { err -> addChat("sys", "⚠️ Live Error: $err") }
                        onAgentReply = { text -> addChat("rose", text) }
                        start()
                    }
                } else {
                    liveClient?.stop()
                    liveClient = null
                }
            } else {
                addChat("sys", "⚠️ Microphone permission denied.")
            }
        }

        Scaffold(
            bottomBar = {
                NavigationBar {
                    listOf(
                        "Chat" to "chat",
                        "Agents" to "agents",
                        "Settings" to "settings",
                    ).forEach { (label, route) ->
                        val backStack by nav.currentBackStackEntryAsState()
                        val current = backStack?.destination?.route
                        NavigationBarItem(
                            selected = current == route,
                            onClick = { nav.navigate(route) { launchSingleTop = true } },
                            icon = {},
                            label = { Text(label) },
                        )
                    }
                }
            },
        ) { pad ->
            NavHost(nav, startDestination = "chat", modifier = Modifier.padding(pad)) {
                composable("chat") {
                    ChatScreen(
                        statusLabel = statusLabel,
                        lines = lines,
                        onSend = { text ->
                            scope.launch {
                                val connected = status == ConnectionState.CONNECTED
                                runtime.processUserMessage(text, connected, deviceState(), chatCallback())
                            }
                        },
                        onMicTap = { 
                            if (androidx.core.content.ContextCompat.checkSelfPermission(this@MainActivity, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                                if (liveClient != null) {
                                    liveClient?.stop()
                                    liveClient = null
                                } else {
                                    val key = secretStore.get(GeminiClient.KEY_API)
                                    if (key.isNullOrBlank()) {
                                        addChat("sys", "⚠️ Set Gemini API key in Settings first.")
                                    } else {
                                        liveClient = ai.rose.mesh.ai.GeminiLiveClient(key).apply {
                                            onStateChange = { active -> addChat("sys", if (active) "🎙️ Live Voice started..." else "🎙️ Live Voice stopped.") }
                                            onError = { err -> addChat("sys", "⚠️ Live Error: $err") }
                                            onAgentReply = { text -> addChat("rose", text) }
                                            start()
                                        }
                                    }
                                }
                            } else {
                                micPermissionLauncher.launch(android.Manifest.permission.RECORD_AUDIO)
                            }
                        },
                    )
                }
                composable("agents") {
                    AgentsScreen(
                        agents = parseAgents(agentsPayload.value),
                        onInspect = { },
                        onRevoke = { },
                    )
                }
                composable("settings") {
                    val qrLauncher = rememberLauncherForActivityResult(
                        com.journeyapps.barcodescanner.ScanContract()
                    ) { result ->
                        val contents = result.contents
                        if (contents != null && contents.startsWith("rose-mesh://pair")) {
                            scope.launch {
                                val s = settingsStore.current()
                                client.pairFromQr(contents, s.displayName)
                                addChat("sys", "📷 QR Scanned! Connecting...")
                                nav.navigate("chat") { launchSingleTop = true }
                            }
                        }
                    }

                    SettingsScreen(
                        initialServerUrl = settings.serverUrl,
                        initialDisplayName = settings.displayName,
                        initialAutoConnect = settings.autoConnect,
                        hasApiKey = gemini.hasKey(),
                        onSave = { url, name ->
                            scope.launch {
                                settingsStore.setServerUrl(url)
                                settingsStore.setDisplayName(name)
                                runtime.displayName = name
                                addChat("sys", "⚙️ Settings saved.")
                            }
                        },
                        onSaveApiKey = { key ->
                            scope.launch {
                                secretStore.put(GeminiClient.KEY_API, key)
                                addChat("sys", "🔑 Gemini key saved (encrypted).")
                            }
                        },
                        onTestConnection = { urlToTest -> testConnection(urlToTest) },
                        onClearApiKey = {
                            scope.launch {
                                secretStore.delete(GeminiClient.KEY_API)
                                addChat("sys", "🔑 Key removed.")
                            }
                        },
                        onScanQr = {
                            qrLauncher.launch(com.journeyapps.barcodescanner.ScanOptions().apply {
                                setDesiredBarcodeFormats(com.journeyapps.barcodescanner.ScanOptions.QR_CODE)
                                setPrompt("Scan Rose Agent Pairing QR Code")
                                setBeepEnabled(false)
                            })
                        }
                    )
                }
            }
        }
    }

    private fun chatCallback(): MobileAgentRuntime.Callback = object : MobileAgentRuntime.Callback {
        override fun onLine(role: String, t: String) = addChat(role, t)
        override fun onTaskUpdate(taskId: String, st: String) {}
    }

    private fun deviceState(): Router.DeviceState {
        val bm = getSystemService(android.content.Context.BATTERY_SERVICE) as android.os.BatteryManager
        val level = runCatching { bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY) }.getOrDefault(80)
        return Router.DeviceState(level.coerceAtLeast(0), bm.isCharging, onWifi = true)
    }

    private suspend fun testConnection(serverUrl: String): String = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        if (serverUrl.isBlank()) return@withContext "Enter a server address first."
        try {
            val body = withTimeoutOrNull(6000) {
                val url = if (serverUrl.endsWith("/")) "${serverUrl}health" else "$serverUrl/health"
                java.net.URL(url).openStream().bufferedReader().use { it.readText() }
            }
            if (body != null && body.contains("healthy")) "✅ Server reachable."
            else "⚠️ Server responded but health check failed."
        } catch (e: Exception) {
            "❌ Cannot reach $serverUrl (${e.message?.take(80) ?: e.javaClass.simpleName})"
        }
    }

    /** Parse agent.presence peers into UI rows for the Agents tab. */
    private fun parseAgents(raw: String): List<AgentRow> {
        return try {
            val root = kotlinx.serialization.json.Json.parseToJsonElement(raw)
            // It could be an array, or an object with an "agents" array (like mesh.status)
            val arr = if (root is kotlinx.serialization.json.JsonArray) root else {
                (root as? kotlinx.serialization.json.JsonObject)?.get("agents") as? kotlinx.serialization.json.JsonArray
            }
            arr?.mapNotNull { el ->
                val obj = el as? kotlinx.serialization.json.JsonObject ?: return@mapNotNull null
                AgentRow(
                    agentId = (obj["agentId"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: return@mapNotNull null,
                    displayName = (obj["displayName"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: "?",
                    platform = (obj["platform"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: "?",
                    trust = (obj["trust"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: "?",
                    capabilities = emptyList(),
                    status = (obj["status"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: "offline",
                )
            } ?: emptyList()
        } catch (_: Exception) { emptyList() }
    }
}
