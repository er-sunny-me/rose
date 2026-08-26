package ai.rose.mesh.ai

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.util.Base64
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import java.util.concurrent.atomic.AtomicBoolean

class GeminiLiveClient(private val apiKey: String) {

    private val client = OkHttpClient()
    private var webSocket: WebSocket? = null

    private val isLive = AtomicBoolean(false)
    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null

    private val scope = CoroutineScope(Dispatchers.IO + Job())

    var onStateChange: ((Boolean) -> Unit)? = null
    var onError: ((String) -> Unit)? = null
    var onAgentReply: ((String) -> Unit)? = null

    fun start() {
        if (isLive.get()) return
        isLive.set(true)
        onStateChange?.invoke(true)

        val url = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=$apiKey"
        val request = Request.Builder().url(url).build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val setupMsg = buildJsonObject {
                    put("setup", buildJsonObject {
                        put("model", "models/gemini-2.0-flash-exp")
                        put("generationConfig", buildJsonObject {
                            put("responseModalities", buildJsonArray { add("AUDIO") })
                        })
                    })
                }
                webSocket.send(setupMsg.toString())
                startAudioCapture()
                startAudioPlayback()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val root = Json.parseToJsonElement(text).jsonObject
                    val modelTurn = root["serverContent"]?.jsonObject?.get("modelTurn")?.jsonObject
                    modelTurn?.get("parts")?.jsonArray?.forEach { part ->
                        val textPart = part.jsonObject["text"]?.jsonPrimitive?.content
                        if (textPart != null && textPart.isNotBlank()) {
                            onAgentReply?.invoke(textPart)
                        }
                        val inlineData = part.jsonObject["inlineData"]?.jsonObject
                        if (inlineData != null) {
                            val data = inlineData["data"]?.jsonPrimitive?.content
                            if (data != null) {
                                val pcmBytes = Base64.decode(data, Base64.DEFAULT)
                                audioTrack?.write(pcmBytes, 0, pcmBytes.size)
                            }
                        }
                    }
                } catch (e: Exception) { e.printStackTrace() }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                stop()
                onError?.invoke("Live connection failed: ${t.message}")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { stop() }
        })
    }

    @SuppressLint("MissingPermission")
    private fun startAudioCapture() {
        val sampleRate = 16000
        val channelConfig = AudioFormat.CHANNEL_IN_MONO
        val audioFormat = AudioFormat.ENCODING_PCM_16BIT
        val minBufSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
        val buffer = ByteArray(minBufSize)

        audioRecord = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            sampleRate, channelConfig, audioFormat, minBufSize
        )
        audioRecord?.startRecording()

        scope.launch(Dispatchers.IO) {
            while (isLive.get() && audioRecord?.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                val read = audioRecord?.read(buffer, 0, buffer.size) ?: 0
                if (read > 0) {
                    val base64Audio = Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP)
                    val msg = buildJsonObject {
                        put("realtimeInput", buildJsonObject {
                            put("mediaChunks", buildJsonArray {
                                add(buildJsonObject {
                                    put("mimeType", "audio/pcm;rate=16000")
                                    put("data", base64Audio)
                                })
                            })
                        })
                    }
                    webSocket?.send(msg.toString())
                }
            }
        }
    }

    private fun startAudioPlayback() {
        val sampleRate = 24000
        val channelConfig = AudioFormat.CHANNEL_OUT_MONO
        val audioFormat = AudioFormat.ENCODING_PCM_16BIT
        val minBufSize = AudioTrack.getMinBufferSize(sampleRate, channelConfig, audioFormat)

        audioTrack = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(audioFormat)
                    .setSampleRate(sampleRate)
                    .setChannelMask(channelConfig)
                    .build()
            )
            .setBufferSizeInBytes(minBufSize)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        audioTrack?.play()
    }

    fun stop() {
        if (!isLive.get()) return
        isLive.set(false)
        onStateChange?.invoke(false)
        webSocket?.close(1000, "User stopped")
        webSocket = null
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        audioTrack?.stop()
        audioTrack?.release()
        audioTrack = null
    }
}
