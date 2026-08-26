package ai.rose.mesh.ai

import ai.rose.mesh.security.SecretStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.put
import java.net.HttpURLConnection
import java.net.URL

/**
 * Direct Gemini REST client for the mobile agent (Phase 37 §14-15).
 *
 * - The API key lives ONLY in the Keystore-backed SecretStore; it is never
 *   logged, never put into preferences, and never sent anywhere except
 *   Google's generativelanguage endpoint.
 * - Gemini is the single supported provider on mobile (chat + embeddings).
 */
class GeminiClient(private val secretStore: SecretStore) {

    @Serializable
    data class Turn(val role: String, val text: String)

    data class Reply(val text: String, val error: String? = null)

    fun hasKey(): Boolean = !apiKey().isNullOrBlank()

    private fun apiKey(): String? = secretStore.get(KEY_API)?.takeIf { it.isNotBlank() }

    /** Simple chat completion with rolling history. */
    suspend fun chat(
        history: List<Turn>,
        userText: String,
        system: String = DEFAULT_SYSTEM,
        model: String = "gemini-3.5-flash-lite",
    ): Reply = withContext(Dispatchers.IO) {
        val key = apiKey()
            ?: return@withContext Reply("", "No Gemini API key set. Add it in Settings.")
        try {
            val body = buildJsonObject {
                put("systemInstruction", buildJsonObject {
                    put("parts", buildJsonArray { add(buildJsonObject { put("text", system) }) })
                })
                put("contents", buildJsonArray {
                    for (t in history) {
                        add(buildJsonObject {
                            put("role", if (t.role == "assistant") "model" else "user")
                            put("parts", buildJsonArray { add(buildJsonObject { put("text", t.text) }) })
                        })
                    }
                    add(buildJsonObject {
                        put("role", "user")
                        put("parts", buildJsonArray { add(buildJsonObject { put("text", userText) }) })
                    })
                })
                put("generationConfig", buildJsonObject { put("maxOutputTokens", 2048) })
            }

            val conn = URL("$BASE/models/$model:generateContent?key=$key").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.connectTimeout = 15_000
            conn.readTimeout = 60_000
            conn.doOutput = true
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }

            val code = conn.responseCode
            val resBody = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.readText() ?: ""
            if (code !in 200..299) {
                return@withContext Reply("", friendlyHttpError(code, resBody))
            }
            Reply(extractText(resBody).ifEmpty { "(empty reply)" })
        } catch (e: Exception) {
            Reply("", when {
                e.message?.contains("timeout", true) == true -> "Network timeout — check your connection."
                e.message?.contains("Unable to resolve", true) == true -> "You appear offline. Local tasks still work."
                else -> "Gemini request failed: ${e.message}"
            })
        }
    }

    /** Multimodal: send a captured image (base64 JPEG) for vision reasoning. */
    suspend fun describeImage(base64Jpeg: String, prompt: String): Reply =
        withContext(Dispatchers.IO) {
            val key = apiKey() ?: return@withContext Reply("", "No Gemini API key set.")
            try {
                val body = buildJsonObject {
                    put("contents", buildJsonArray {
                        add(buildJsonObject {
                            put("role", "user")
                            put("parts", buildJsonArray {
                                add(buildJsonObject { put("text", prompt) })
                                add(buildJsonObject {
                                    put("inlineData", buildJsonObject {
                                        put("mimeType", "image/jpeg")
                                        put("data", base64Jpeg)
                                    })
                                })
                            })
                        })
                    })
                }
                val conn = URL("$BASE/models/gemini-3.5-flash-lite:generateContent?key=$key").openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                val resBody = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.readText() ?: ""
                if (code !in 200..299) return@withContext Reply("", friendlyHttpError(code, resBody))
                Reply(extractText(resBody))
            } catch (e: Exception) {
                Reply("", "Image reasoning failed: ${e.message}")
            }
        }

    private fun extractText(resBody: String): String = try {
        val obj = Json.parseToJsonElement(resBody).toString()
        // Lightweight extraction without full response models:
        Regex("\"text\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").findAll(obj)
            .joinToString("") { unescape(it.groupValues[1]) }
    } catch (_: Exception) {
        ""
    }

    private fun unescape(s: String): String = s
        .replace("\\n", "\n").replace("\\\"", "\"").replace("\\\\", "\\")

    private fun friendlyHttpError(code: Int, body: String): String = when (code) {
        400 -> "Bad request (400). Check the model name or prompt."
        401, 403 -> "Gemini rejected the API key ($code). Re-enter it in Settings."
        429 -> "Rate limited by Gemini (429). Try again shortly."
        in 500..599 -> "Gemini server error ($code). Try again."
        else -> "Gemini error $code: ${body.take(140)}"
    }

    companion object {
        const val KEY_API = "gemini.apiKey"
        private const val BASE = "https://generativelanguage.googleapis.com/v1beta"

        const val DEFAULT_SYSTEM =
            "You are Rose, a helpful mobile AI agent. Always reply in Hinglish " +
            "(Roman Hindi + English). Be concise. If a task clearly needs a PC " +
            "(terminal, filesystem, big compute), say you will delegate it to the PC agent."
    }
}
