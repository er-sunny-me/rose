package ai.rose.mesh.service

import android.accessibilityservice.AccessibilityService
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Rect
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

class RoseAccessibilityService : AccessibilityService() {
    companion object {
        const val ACTION_EXECUTE_COMMAND = "ai.rose.mesh.EXECUTE_COMMAND"
        const val EXTRA_COMMAND = "command"
        const val EXTRA_TASK_ID = "taskId"
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == ACTION_EXECUTE_COMMAND) {
                val cmdJson = intent.getStringExtra(EXTRA_COMMAND) ?: return
                val taskId = intent.getStringExtra(EXTRA_TASK_ID) ?: return
                executeCommand(cmdJson, taskId)
            }
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        val filter = IntentFilter(ACTION_EXECUTE_COMMAND)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(receiver, filter)
        }
        Log.i("RoseAccessibility", "Service Connected & Receiver Registered")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // We can track current package name here if needed
    }

    override fun onInterrupt() {
        Log.w("RoseAccessibility", "Service Interrupted")
    }

    override fun onDestroy() {
        unregisterReceiver(receiver)
        super.onDestroy()
    }

    private fun executeCommand(cmdStr: String, taskId: String) {
        try {
            val cmd = JSONObject(cmdStr)
            val action = cmd.getString("action")
            var result = "success"

            val rootNode = rootInActiveWindow
            if (rootNode == null) {
                sendResult(taskId, "failed", "No active window")
                return
            }

            when (action) {
                "click_text" -> {
                    val text = cmd.getString("text")
                    val found = findNodeByText(rootNode, text)
                    if (found != null && found.isClickable) {
                        found.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    } else if (found != null && found.parent?.isClickable == true) {
                        found.parent.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    } else {
                        result = "Text not found or not clickable"
                    }
                }
                "global_action" -> {
                    val globalAction = cmd.getInt("global_action_id")
                    performGlobalAction(globalAction)
                }
                "get_screen_text" -> {
                    val texts = mutableListOf<String>()
                    extractAllText(rootNode, texts)
                    result = texts.joinToString("\n")
                }
                "scroll_forward" -> {
                    val scrollable = findScrollableNode(rootNode)
                    if (scrollable != null) {
                        scrollable.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
                    } else {
                        result = "No scrollable area found"
                    }
                }
                else -> {
                    result = "Unknown action: $action"
                }
            }
            sendResult(taskId, if (result.contains("not found") || result.contains("Unknown")) "failed" else "completed", result)
        } catch (e: Exception) {
            sendResult(taskId, "failed", e.message ?: "Unknown error")
        }
    }

    private fun findNodeByText(node: AccessibilityNodeInfo, text: String): AccessibilityNodeInfo? {
        if (node.text?.toString()?.contains(text, ignoreCase = true) == true) return node
        if (node.contentDescription?.toString()?.contains(text, ignoreCase = true) == true) return node
        
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = findNodeByText(child, text)
            if (found != null) return found
        }
        return null
    }

    private fun findScrollableNode(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isScrollable) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = findScrollableNode(child)
            if (found != null) return found
        }
        return null
    }

    private fun extractAllText(node: AccessibilityNodeInfo, list: MutableList<String>) {
        if (node.text != null && node.text.isNotBlank()) {
            list.add(node.text.toString())
        } else if (node.contentDescription != null && node.contentDescription.isNotBlank()) {
            list.add(node.contentDescription.toString())
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            extractAllText(child, list)
        }
    }

    private fun sendResult(taskId: String, state: String, summary: String) {
        val intent = Intent("ai.rose.mesh.TASK_RESULT").apply {
            putExtra("taskId", taskId)
            putExtra("state", state)
            putExtra("summary", summary)
        }
        sendBroadcast(intent)
    }
}
