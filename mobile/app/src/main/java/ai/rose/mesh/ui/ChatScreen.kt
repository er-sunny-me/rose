package ai.rose.mesh.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Chat screen (Phase 37 §35): native mobile pattern — transcript + input bar,
 * connection status chip, tool/task cards rendered as elevated list items.
 */
data class ChatLine(val role: String, val text: String)

@Composable
fun ChatScreen(
    statusLabel: String,
    lines: List<ChatLine>,
    onSend: (String) -> Unit,
    onMicTap: () -> Unit,
) {
    var draft by remember { mutableStateOf("") }

    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(12.dp).imePadding()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("🌹 ROSE", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.weight(1f))
            StatusChip(statusLabel)
        }
        Spacer(Modifier.height(8.dp))

        LazyColumn(Modifier.weight(1f)) {
            items(lines) { line ->
                val isUser = line.role == "you"
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                    colors = CardDefaults.cardColors(),
                ) {
                    Column(Modifier.padding(10.dp)) {
                        Text(if (isUser) "You" else "Rose", style = MaterialTheme.typography.labelSmall)
                        Text(line.text, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Message…") },
                singleLine = true,
            )
            Spacer(Modifier.width(8.dp))
            Button(onClick = {
                if (draft.isNotBlank()) { onSend(draft.trim()); draft = "" }
            }) { Text("Send") }
            Spacer(Modifier.width(6.dp))
            // Tap-to-talk; continuous mode via Gemini Live session.
            FilledTonalButton(onClick = onMicTap) { Text("🎙") }
        }
    }
}

@Composable
fun StatusChip(label: String) {
    val color = when {
        label.equals("Connected", true) -> MaterialTheme.colorScheme.primary
        label.equals("Offline", true) -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.tertiary
    }
    AssistChip(onClick = {}, label = { Text(label) }, leadingIcon = {
        Text("●", color = color)
    })
}
