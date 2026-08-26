package ai.rose.mesh

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import ai.rose.mesh.net.MeshClient
import ai.rose.mesh.security.ApiPasswordStore
import ai.rose.mesh.service.RoseAccessibilityService
import org.json.JSONObject
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var meshClient: MeshClient
    private lateinit var statusText: TextView
    private lateinit var serverInput: EditText
    private lateinit var passwordInput: EditText
    private lateinit var nameInput: EditText
    private lateinit var devicesText: TextView
    private lateinit var passwordStore: ApiPasswordStore
    
    private var currentOwner: String = ""

    private val resultReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == "ai.rose.mesh.TASK_RESULT") {
                val taskId = intent.getStringExtra("taskId") ?: return
                val state = intent.getStringExtra("state") ?: return
                val summary = intent.getStringExtra("summary") ?: return
                
                val resultMsg = JSONObject().apply {
                    put("type", "agent.task.result")
                    put("v", 1)
                    put("nonce", java.util.UUID.randomUUID().toString())
                    put("ts", System.currentTimeMillis())
                    put("to", currentOwner)
                    put("taskId", taskId)
                    put("state", state)
                    put("summary", summary)
                }
                meshClient.send(resultMsg.toString())
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }
        
        statusText = TextView(this).apply {
            text = "Status: Offline"
            textSize = 20f
            setPadding(0, 0, 0, 32)
        }
        layout.addView(statusText)
        
        val settings = getSharedPreferences("mesh", MODE_PRIVATE)
        passwordStore = ApiPasswordStore(this)
        serverInput = EditText(this).apply {
            hint = "Server URL"
            setText(settings.getString("serverUrl", "https://nexusbot.in"))
        }
        layout.addView(serverInput)

        passwordInput = EditText(this).apply {
            hint = "API password"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        layout.addView(passwordInput)

        nameInput = EditText(this).apply {
            hint = "Device name"
            setText(settings.getString("deviceName", android.os.Build.MODEL ?: "Android Agent"))
        }
        layout.addView(nameInput)
        
        val btnPair = Button(this).apply {
            text = "Connect with API Password"
            setOnClickListener {
                val serverUrl = serverInput.text.toString().trim().trimEnd('/')
                val password = passwordInput.text.toString()
                val deviceName = nameInput.text.toString().trim().ifEmpty { "Android Agent" }
                if (serverUrl.startsWith("https://") && password.isNotEmpty()) {
                    settings.edit().putString("serverUrl", serverUrl).putString("deviceName", deviceName).apply()
                    passwordStore.save(password)
                    meshClient.connect(serverUrl, password, deviceName)
                } else {
                    Toast.makeText(this@MainActivity, "Enter an HTTPS server URL and API password", Toast.LENGTH_SHORT).show()
                }
            }
        }
        layout.addView(btnPair)
        
        val btnAccess = Button(this).apply {
            text = "Enable Accessibility Service"
            setOnClickListener {
                startActivity(Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
        }
        layout.addView(btnAccess)

        val btnDevices = Button(this).apply {
            text = "Who Is Connected?"
            setOnClickListener { refreshDevices() }
        }
        layout.addView(btnDevices)

        devicesText = TextView(this).apply {
            textSize = 14f
            typeface = android.graphics.Typeface.MONOSPACE
            text = "Tap the button to see connected devices.\nLive presence updates appear here automatically."
            setPadding(0, 16, 0, 16)
        }
        layout.addView(devicesText)

        setContentView(layout)

        val deviceId = settings.getString("deviceId", null) ?: java.util.UUID.randomUUID().toString().also {
            settings.edit().putString("deviceId", it).apply()
        }
        meshClient = MeshClient(lifecycleScope, deviceId, object : MeshClient.Listener {
            override fun onStateChange(state: String) {
                runOnUiThread {
                    statusText.text = "Status: " + state
                }
            }

            override fun onMessage(json: String) {
                try {
                    val msg = JSONObject(json)
                    when (msg.optString("type")) {
                        "agent.task.delegate" -> {
                            val taskId = msg.getString("taskId")
                            val goalStr = msg.getString("goal")
                            currentOwner = msg.optString("ownerAgent", msg.optString("from"))

                            val intent = Intent(RoseAccessibilityService.ACTION_EXECUTE_COMMAND).apply {
                                putExtra(RoseAccessibilityService.EXTRA_COMMAND, goalStr)
                                putExtra(RoseAccessibilityService.EXTRA_TASK_ID, taskId)
                            }
                            sendBroadcast(intent)
                        }
                        // Gateway broadcasts the live peer list on every connect/change.
                        "agent.presence" -> renderAgents(msg.optJSONArray("peers"), null, -1)
                    }
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
        })

        // Reconnect after an activity/process restart. The API password is encrypted
        // with this device's Android Keystore key, never saved as plain text.
        val savedPassword = passwordStore.read()
        val savedServerUrl = settings.getString("serverUrl", null)
        val savedDeviceName = settings.getString("deviceName", null)
        if (!savedPassword.isNullOrEmpty() && !savedServerUrl.isNullOrEmpty() && !savedDeviceName.isNullOrEmpty()) {
            meshClient.connect(savedServerUrl, savedPassword, savedDeviceName)
        }
    }

    /** Pull the full mesh summary over REST (button refresh). */
    private fun refreshDevices() {
        val serverUrl = serverInput.text.toString().trim().trimEnd('/')
        val password = passwordStore.read()
        if (serverUrl.isEmpty() || password.isNullOrEmpty()) {
            Toast.makeText(this, "Connect first — server URL and API password needed", Toast.LENGTH_SHORT).show()
            return
        }
        devicesText.text = "Loading devices…"
        meshClient.fetchMeshSummary(serverUrl, password) { body ->
            try {
                val d = JSONObject(body)
                val err = d.optString("error", "")
                if (err.isNotEmpty() && !d.has("agents")) {
                    devicesText.text = "Error: $err"
                    return@fetchMeshSummary
                }
                renderAgents(d.optJSONArray("agents"), d.optInt("total", -1), d.optInt("online", -1))
            } catch (e: Exception) {
                devicesText.text = "Parse error: ${e.message}"
            }
        }
    }

    /** Render an agents JSONArray (from REST /api/mesh or live agent.presence). */
    private fun renderAgents(agents: org.json.JSONArray?, total: Int?, online: Int?) {
        if (agents == null) return
        val sb = StringBuilder()
        val onlineCount = if (online != null && online >= 0) online else {
            var n = 0
            for (i in 0 until agents.length()) {
                if (agents.getJSONObject(i).optString("status") == "online") n++
            }
            n
        }
        sb.append("Connected Devices (${if (total != null && total >= 0) total else agents.length()}):\n")
        sb.append("● online: $onlineCount · ○ offline: ${agents.length() - onlineCount}\n\n")
        for (i in 0 until agents.length()) {
            val a = agents.getJSONObject(i)
            val status = a.optString("status", "offline")
            val dot = when (status) {
                "online" -> "●"; "degraded" -> "⚠"; else -> "○"
            }
            sb.append("$dot ${status.uppercase()}  ${a.optString("displayName", "?")} [${a.optString("platform", "?")}]\n")
            sb.append("   last seen ${relTime(a.optLong("lastSeen"))}\n")
            sb.append("   ${a.optString("agentId")}\n\n")
        }
        runOnUiThread { devicesText.text = sb.toString().trimEnd() }
    }

    private fun relTime(ts: Long): String {
        if (ts <= 0) return "never"
        val s = (System.currentTimeMillis() - ts) / 1000
        return when {
            s < 60 -> "${s}s ago"
            s < 3600 -> "${s / 60}m ago"
            s < 86400 -> "${s / 3600}h ago"
            else -> "${s / 86400}d ago"
        }
    }

    override fun onResume() {
        super.onResume()
        val filter = IntentFilter("ai.rose.mesh.TASK_RESULT")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(resultReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(resultReceiver, filter)
        }
    }

    override fun onPause() {
        super.onPause()
        unregisterReceiver(resultReceiver)
    }

    override fun onDestroy() {
        super.onDestroy()
        meshClient.disconnect()
    }
}

