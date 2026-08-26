# Implementation Plan - Fix Build Failure (SDK & AGP Version Mismatch)

The project is currently failing to build because some dependencies (specifically `androidx.compose.runtime` and `androidx.lifecycle`) require a higher `compileSdk` and Android Gradle Plugin (AGP) version than what is currently configured.

## Proposed Changes

### Build Configuration

#### [MODIFY] [root build.gradle.kts](file:///C:/Users/alone/OneDrive/Desktop/Rose/mobile/build.gradle.kts)
- Upgrade AGP version from `8.5.2` to `9.1.0` to support modern dependencies and higher SDK versions.

#### [MODIFY] [app build.gradle.kts](file:///C:/Users/alone/OneDrive/Desktop/Rose/mobile/app/build.gradle.kts)
- Upgrade `compileSdk` to `37` (as required by Lifecycle 2.11.0).
- Upgrade `targetSdk` to `35` (or `37`) to align with modern standards.
- Remove hardcoded version for `compose-bom` and use the one from the version catalog (`libs.androidx.compose.bom`).
- Remove hardcoded version for `lifecycle-runtime-compose` and use the version catalog or align it with the BOM.

#### [MODIFY] [libs.versions.toml](file:///C:/Users/alone/OneDrive/Desktop/Rose/mobile/gradle/libs.versions.toml)
- Ensure all related dependencies are consistent.

## Verification Plan

### Automated Tests
- Run `./gradlew :app:assembleDebug` to verify the build now succeeds.
- Run `./gradlew test` to ensure no regressions in unit tests.

### Manual Verification
- Sync the project with Gradle in Android Studio to ensure the IDE recognizes the new configuration.
