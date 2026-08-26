# 📱 Rose Mobile Agent (Android)

Native **Kotlin + Jetpack Compose** app — not a WebView wrapper. It runs its own
lightweight Agent Runtime and joins the Agent Mesh as a first-class citizen.

## Layout

```
mobile/app/src/main/java/ai/rose/mesh/
├── protocol/RoseProtocol.kt    # mirror of shared protocol JSON (kotlinx.serialization)
├── net/MeshClient.kt           # OkHttp WebSocket + bounded-backoff reconnect
├── security/SecretStore.kt     # interface + KeystoreSecretStore (AES-GCM, hardware key)
├── policy/RosePolicy.kt        # Android permission + Rose Policy gate, smart Router
├── agent/MobileAgentRuntime.kt # local tasks, delegation, UNKNOWN reconciliation
├── notify/Notifications.kt     # channels: tasks / approvals / system / security
└── ui/                         # Compose screens (Chat, Agents) + Material3 Rose theme
```

## Build

Requires Android Studio (Koala+) or SDK 34:

```bash
cd mobile
./gradlew :app:assembleDebug       # debug APK
./gradlew :app:testDebugUnitTest   # JVM unit tests
./gradlew :app:connectedDebugAndroidTest   # instrumentation (device/emulator)
```

Release builds expect signing config from CI secrets / local.properties —
keystores are never committed (§122).

## Connection flow

1. Enter the HTTPS mesh server URL, API password, and device name.
2. Tap **Connect with API Password**. The password travels only in the HTTPS
   WebSocket Authorization header and is not stored by the app.
3. The app persists a random device ID, so reconnects retain the same agent.

## Offline behaviour

- Local chat, local memory and mobile-native tools keep working offline.
- Mesh-dependent actions show **Offline / Waiting for server** instead of failing silently.
- Reconnect uses bounded backoff (1s→64s, max 10 tries), then reconciles:
  delegated tasks become **UNKNOWN** and are queried — never blind-retried.

## Privacy

Mic/camera/location use requires BOTH the Android permission AND the Rose
policy toggle (Settings → Permissions). Active mic/camera shows a visible
indicator; clipboard and location are denied by default.
