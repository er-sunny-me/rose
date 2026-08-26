package ai.rose.mesh.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

data class AgentRow(
    val agentId: String,
    val displayName: String,
    val platform: String,
    val status: String,      // online | offline | degraded
    val trust: String,
    val capabilities: List<String>,
)

/**
 * Mesh view (Phase 37 §80): clean topology list with per-agent actions.
 */
@Composable
fun AgentsScreen(
    agents: List<AgentRow>,
    onInspect: (AgentRow) -> Unit,
    onRevoke: (AgentRow) -> Unit,
) {
    LazyColumn(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Text("Your Agents", style = MaterialTheme.typography.titleLarge) }
        items(agents) { a ->
            ElevatedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp)) {
                    Row {
                        val dot = when (a.status) {
                            "online" -> "●"; "degraded" -> "⚠"; else -> "○"
                        }
                        Text("$dot ${a.displayName}", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.weight(1f))
                        Text(a.platform, style = MaterialTheme.typography.labelMedium)
                    }
                    Text(
                        "${a.status} · trust: ${a.trust}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (a.capabilities.isNotEmpty()) {
                        Text(a.capabilities.joinToString(" · "), style = MaterialTheme.typography.labelSmall)
                    }
                    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilledTonalButton(onClick = { onInspect(a) }) { Text("Inspect") }
                        if (a.trust != "revoked") {
                            OutlinedButton(onClick = { onRevoke(a) }) { Text("Revoke") }
                        }
                    }
                }
            }
        }
    }
}
