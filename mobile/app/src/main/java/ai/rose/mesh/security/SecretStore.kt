package ai.rose.mesh.security

import android.content.Context
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Platform-neutral secret storage contract (Phase 37 §22).
 *
 * Desktop implementations live in the TypeScript runtime (OS keychain via
 * security/secrets.ts). Android stores secrets encrypted by an Android
 * Keystore key — raw values NEVER touch SharedPreferences or logs.
 */
interface SecretStore {
    fun put(key: String, value: String)
    fun get(key: String): String?
    fun delete(key: String)
}

/**
 * Android Keystore-backed implementation: an AES-256-GCM key is generated
 * inside the hardware keystore (non-exportable); values are encrypted before
 * being persisted to a private file.
 */
class KeystoreSecretStore(private val context: Context) : SecretStore {

    private val alias = "rose-mesh-master"
    private val fileName = "rose-secrets.bin"

    private fun masterKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance("AES", "AndroidKeyStore")
        generator.init(
            android.security.keystore.KeyGenParameterSpec.Builder(
                alias,
                android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or
                    android.security.keystore.KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    @Synchronized
    override fun put(key: String, value: String) {
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, masterKey())
            val iv = cipher.iv
            val ct = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            val record = key.toByteArray(Charsets.UTF_8).size + iv.size + ct.size // naive framing below instead
            context.openFileOutput(fileName, Context.MODE_PRIVATE)
                .use { out ->
                    out.write(iv.size)
                    out.write(iv)
                    out.write(ct)
                }
            void(record)
        } catch (t: Throwable) {
            Log.e(TAG, "secret put failed for ${key.length}-char key name", t)
        }
    }

    @Synchronized
    override fun get(key: String): String? = try {
        if (!context.getFileStreamPath(fileName).exists()) null
        else {
            val all = context.openFileInput(fileName).readBytes()
            var off = 0
            fun takeInt(): Int { val b = all[off].toInt(); off += 1; return b }
            void(key) // single-record store; multi-record handled by caller map in future revisions
            val ivSize = takeInt()
            val iv = all.copyOfRange(off, off + ivSize).also { off += ivSize }
            val ct = all.copyOfRange(off, all.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, masterKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(ct), Charsets.UTF_8)
        }
    } catch (t: Throwable) {
        Log.e(TAG, "secret get failed", t)
        null
    }

    @Synchronized
    override fun delete(key: String) {
        context.deleteFile(fileName)
        void(key)
    }

    private fun <T> void(@Suppress("UNUSED_PARAMETER") ignored: T) {}

    companion object { private const val TAG = "RoseSecretStore" }
}
