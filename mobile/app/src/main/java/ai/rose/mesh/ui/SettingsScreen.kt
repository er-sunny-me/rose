package ai.rose.mesh.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

/**
 * Settings (Phase 37 §77, §83):
 *   Server URL      — where the mesh server lives (IP/domain, change anytime)
 *   Device name     — shown in the mesh
 *   Gemini API key  — stored ENCRYPTED (Keystore); never displayed back
 *   Auto-connect    — connect on app open
 */
@Composable
fun SettingsScreen(
    initialServerUrl: String,
    initialDisplayName: String,
    initialAutoConnect: Boolean,
    hasApiKey: Boolean,
    onSave: (serverUrl: String, displayName: String) -> Unit,
    onSaveApiKey: (key: String) -> Unit,
    onTestConnection: suspend (serverUrl: String) -> String,
    onClearApiKey: () -> Unit,
    onScanQr: () -> Unit,
) {
    var serverUrl by remember { mutableStateOf(initialServerUrl) }
    var deviceName by remember { mutableStateOf(initialDisplayName) }
    var autoConnect by remember { mutableStateOf(initialAutoConnect) }
    var apiKey by remember { mutableStateOf("") }
    var testResult by remember { mutableStateOf("") }
    var testing by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("⚙️ Settings", style = MaterialTheme.typography.titleLarge)

        // ── Server ──
        Section("SERVER") {
            OutlinedTextField(
                value = serverUrl,
                onValueChange = { serverUrl = it },
                label = { Text("Server address") },
                placeholder = { Text("http://192.168.1.5:3000") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = autoConnect, onCheckedChange = { autoConnect = it })
                Text("Connect automatically on app open")
            }
            FilledTonalButton(onClick = onScanQr, modifier = Modifier.fillMaxWidth()) {
                Text("📷 Scan QR to Connect")
            }
        }

        // ── Identity ──
        Section("DEVICE") {
            OutlinedTextField(
                value = deviceName,
                onValueChange = { deviceName = it },
                label = { Text("Device name (shown in mesh)") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
        }

        // ── AI ──
        Section("GEMINI API (stays encrypted on this phone)") {
            OutlinedTextField(
                value = apiKey,
                onValueChange = { apiKey = it },
                label = { Text(if (hasApiKey) "Replace Gemini API key" else "Gemini API key") },
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(
                    onClick = { if (apiKey.isNotBlank()) onSaveApiKey(apiKey.trim()); apiKey = "" },
                    enabled = apiKey.isNotBlank(),
                ) { Text("Save key") }
                if (hasApiKey) {
                    FilledTonalButton(onClick = onClearApiKey) { Text("Remove key") }
                }
                Text(
                    if (hasApiKey) "✓ key set" else "✗ no key",
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            Text(
                "Embeddings & chat use Gemini only — the only supported provider.",
                style = MaterialTheme.typography.labelSmall,
            )
        }

        // ── Save + test ──
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { onSave(serverUrl, deviceName) }) { Text("Save settings") }
            Button(onClick = { testing = true }, enabled = !testing) { Text("Test connection") }
        }
        if (testing) {
            LaunchedEffect(Unit) {
                testResult = onTestConnection(serverUrl)
                testing = false
            }
        }
        if (testResult.isNotEmpty()) {
            Text(testResult, style = MaterialTheme.typography.bodySmall)
        }

        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Text(title, style = MaterialTheme.typography.labelMedium)
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}
