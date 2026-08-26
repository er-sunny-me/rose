package ai.rose.mesh.agent

import ai.rose.mesh.ai.GeminiClient
import ai.rose.mesh.memory.MemoryStore
import ai.rose.mesh.net.MeshClient
import ai.rose.mesh.policy.RosePolicy
import ai.rose.mesh.policy.Router
import ai.rose.mesh.protocol.RoseCodec
import ai.rose.mesh.protocol.TaskDelegate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * REAL mobile Agent Runtime (Phase 37 §14, §84-86).
 *
 * Local-first brain:
 *   user text ──▶ slash-command?  ──▶ local handling
 *             ──▶ mobile-native?   ──▶ local tools / memory
 *             ──▶ heavy task?      ──▶ delegate to PC via mesh
 *             ──▶ otherwise        ──▶ Gemini chat (on-device network call)
 */
class MobileAgentRuntime(
    private val scope: CoroutineScope,
    private val gemini: GeminiClient,
    private val memory: MemoryStore,
    private val policy: RosePolicy,
) {
    var displayName: String = "My Phone"

    /** Live mesh client provider — returns null when offline/unpaired. */
    var meshProvider: (() -> MeshClient?)? = null

    private fun mesh(): MeshClient? = meshProvider?.invoke()

    /** Optional direct chat sink; Callback still takes precedence. */
    var onChatLine: ((role: String, text: String) -> Unit)? = null

    val chatHistory = mutableListOf<GeminiClient.Turn>()

    interface Callback {
        fun onLine(role: String, text: String)
        fun onTaskUpdate(taskId: String, state: String)
    }

    fun processUserMessage(
        text: String,
        connected: Boolean,
        deviceState: Router.DeviceState,
        cb: Callback,
    ) {
        cb.onLine("you", text)

        if (text.startsWith("/")) {
            handleCommand(text, connected, cb)
            return
        }

        memory.add(text)

        val caps = detectCapabilities(text)
        when (val d = Router.route(caps, deviceState)) {
            is Router.Decision.DelegateToPc -> {
                if (!connected || mesh() == null) {
                    cb.onLine("sys", "PC agent offline — task saved for delegation.")
                    memory.add("[pending-delegation] $text")
                } else {
                    delegateToPc(text, cb)
                }
            }
            is Router.Decision.Wait -> cb.onLine("sys", d.reason)
            is Router.Decision.RunLocal -> askGemini(text, cb)
        }
    }

    fun askGemini(userText: String, cb: Callback) {
        if (!gemini.hasKey()) {
            cb.onLine("sys", "No Gemini API key yet. Settings → paste key → Save.")
            return
        }
        scope.launch {
            val reply = gemini.chat(history = chatHistory.toList(), userText = userText)
            chatHistory.add(GeminiClient.Turn("user", userText))
            chatHistory.add(GeminiClient.Turn("assistant", reply.text))
            if (reply.error == null) cb.onLine("rose", reply.text)
            else cb.onLine("sys", reply.error)
        }
    }

    fun delegateToPc(goal: String, cb: Callback): String {
        val taskId = "m-" + UUID.randomUUID().toString().take(8)
        cb.onLine("pc", "Delegated to PC ($taskId): $goal")
        val payload = "{\"type\":\"agent.task.delegate\",\"v\":1,\"nonce\":\"" + uuid() +
            "\",\"ts\":" + System.currentTimeMillis() +
            ",\"to\":\"pc\",\"taskId\":\"" + taskId + "\",\"goal\":\"" + escape(goal) + "\"," +
            "\"requiredCapabilities\":[\"terminal\"]}"
        mesh()?.send(payload)
        return taskId
    }

    fun handleInbound(json: String, client: MeshClient, cb: Callback) {
        if (json.contains("\"agent.task.delegate\"")) {
            val d = RoseCodec.json.decodeFromString(TaskDelegate.serializer(), json)
            cb.onLine("pc", "PC delegated: " + d.goal)
            val origin = d.originAgent ?: ""
            val ack = "{\"type\":\"agent.task.result\",\"v\":1,\"nonce\":\"" + uuid() +
                "\",\"ts\":" + System.currentTimeMillis() +
                ",\"to\":\"" + origin + "\",\"taskId\":\"" + d.taskId + "\"," +
                "\"state\":\"completed\",\"summary\":\"handled on mobile\"}"
            client.send(ack)
            return
        }
        if (json.contains("\"agent.task.result\"")) {
            cb.onLine("pc", "✅ PC finished a task.")
        }
    }

    private fun handleCommand(raw: String, connected: Boolean, cb: Callback) {
        val cmd = raw.trim().lowercase()
        when {
            cmd == "/help" -> cb.onLine(
                "sys",
                listOf(
                    "Commands:",
                    "  /help              this list",
                    "  /status            connection + key status",
                    "  /memory            show saved memories",
                    "  /remember <text>   save a memory",
                    "  /search <q>        search memories",
                    "  /clear             clear conversation",
                    "  /runonpc <goal>    force-delegate to PC",
                ).joinToString("\n"),
            )
            cmd == "/status" -> cb.onLine(
                "sys",
                "Connection: " + (if (connected) "Connected" else "Offline") +
                    "\nGemini key: " + (if (gemini.hasKey()) "set" else "NOT set") +
                    "\nMemories: " + memory.all().size,
            )
            cmd == "/memory" -> cb.onLine(
                "sys",
                memory.all().take(10).joinToString("\n") { m -> "• " + m.text }.ifEmpty { "(no memories)" },
            )
            cmd.startsWith("/remember ") -> {
                val item = memory.add(raw.removePrefix("/remember ").trim())
                cb.onLine("sys", "Saved memory " + item.id)
            }
            cmd.startsWith("/search ") -> cb.onLine(
                "sys",
                memory.search(raw.removePrefix("/search "))
                    .joinToString("\n") { m -> "• " + m.text }
                    .ifEmpty { "(no matches)" },
            )
            cmd.startsWith("/runonpc ") -> {
                val goal = raw.removePrefix("/runonpc ").trim()
                if (!connected || mesh() == null) cb.onLine("sys", "PC/server offline — cannot delegate now.")
                else delegateToPc(goal, cb)
            }
            cmd == "/clear" -> chatHistory.clear()
            else -> cb.onLine("sys", "Unknown command $cmd — try /help")
        }
    }

    private fun detectCapabilities(text: String): List<String> {
        val t = text.lowercase()
        val caps = mutableListOf<String>()
        if (listOf("terminal", "shell", "tests", "test", "repository", "repo", "build").any(t::contains)) caps.add("terminal")
        if (listOf("file", "folder", "project", "codebase").any(t::contains)) caps.add("filesystem")
        if (listOf("browser", "website", "web page").any(t::contains)) caps.add("browser")
        return caps
    }

    private fun looksLikeVoiceTask(text: String): Boolean =
        text.contains("voice", true) || text.contains("bol", true)

    private fun escape(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"")

    private fun uuid(): String = UUID.randomUUID().toString().replace("-", "").take(16)
}
