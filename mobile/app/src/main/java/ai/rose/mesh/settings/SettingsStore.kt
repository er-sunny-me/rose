package ai.rose.mesh.settings

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "rose_settings")

/**
 * Non-secret app settings (Phase 37 §77, §83).
 *
 * The Gemini API key is deliberately NOT here — it lives encrypted in the
 * Android Keystore-backed SecretStore. Only the server URL, display name and
 * toggles are plain preferences.
 */
data class RoseSettings(
    val serverUrl: String,       // e.g. http://192.168.1.5:3000 or https://mesh.example.com
    val displayName: String,
    val autoConnect: Boolean,
)

class SettingsStore(private val context: Context) {

    private object Keys {
        val SERVER_URL = stringPreferencesKey("server_url")
        val DISPLAY_NAME = stringPreferencesKey("display_name")
        val AUTO_CONNECT = booleanPreferencesKey("auto_connect")
    }

    val settings: Flow<RoseSettings> = context.dataStore.data.map { p ->
        RoseSettings(
            serverUrl = p[Keys.SERVER_URL] ?: "https://nexusbot.in",
            displayName = p[Keys.DISPLAY_NAME] ?: "My Phone",
            autoConnect = p[Keys.AUTO_CONNECT] ?: true,
        )
    }

    suspend fun current(): RoseSettings = settings.first()

    suspend fun setServerUrl(url: String) {
        context.dataStore.edit { it[Keys.SERVER_URL] = url.trim().removeSuffix("/") }
    }

    suspend fun setDisplayName(name: String) {
        context.dataStore.edit { it[Keys.DISPLAY_NAME] = name.trim().ifEmpty { "My Phone" } }
    }

    suspend fun setAutoConnect(v: Boolean) {
        context.dataStore.edit { it[Keys.AUTO_CONNECT] = v }
    }
}
