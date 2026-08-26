package ai.rose.mesh.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Rose brand tokens shared conceptually with the Web panel & TUI (Phase 37 §73). */
object RoseTokens {
    val RoseRed = Color(0xFFE5484D)
    val RoseDarkBg = Color(0xFF141416)
    val RoseLightBg = Color(0xFFFDF7F7)
}

private val DarkScheme = darkColorScheme(
    primary = RoseTokens.RoseRed,
    background = RoseTokens.RoseDarkBg,
)

private val LightScheme = lightColorScheme(
    primary = RoseTokens.RoseRed,
    background = RoseTokens.RoseLightBg,
)

@Composable
fun RoseTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) DarkScheme else LightScheme, content = content)
}
