# 🤖 Android Notes

## Requirements

- Android Studio Koala+ / SDK Platform 34
- JDK 17
- A device or emulator on API 26+

## Build & run

```bash
cd mobile
./gradlew :app:assembleDebug
./gradlew installDebug          # with a connected device
```

Open `mobile/` directly in Android Studio for the full Compose preview experience.

## Signing (release)

Keystores/passwords are NEVER committed:

```bash
# local.properties (git-ignored)
ROSE_UPLOAD_STORE_FILE=/safe/path/upload.jks
ROSE_UPLOAD_STORE_PASSWORD=…
ROSE_UPLOAD_KEY_ALIAS=rose
```

CI reads the same values from encrypted secrets and produces the signed APK.

## Architecture notes

- **Kotlin-first**; Java only where platform libs demand it.
- UI: Jetpack Compose + Material 3, Rose tokens (`ui/RoseTheme.kt`).
- Networking: OkHttp WebSocket to `/mesh/ws` with bounded reconnect backoff.
- Secrets: Android Keystore AES-GCM master key wraps stored values
  (`security/KeystoreSecretStore.kt`). Nothing sensitive in prefs/logs.
- Background work: foreground service (`MeshForegroundService`) +
  WorkManager for deferred jobs — no unrestricted permanent services.
- Protocol: `protocol/RoseProtocol.kt` mirrors
  `/shared/protocol/rose-mesh-protocol.json` v1; version mismatch closes the
  socket with code 4000 so old clients fail fast instead of corrupting streams.

## Known limitations

- Voice: Gemini Live tap-to-talk hooks exist; continuous mode lands with the
  audio focus integration pass.
- Camera/gallery capture is wired through the policy gate; screenshot capture
  is intentionally absent until MediaProjection consent UX ships.
