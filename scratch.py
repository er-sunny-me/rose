
import os

file = "mobile/app/src/main/java/ai/rose/mesh/MainActivity.kt"
with open(file, "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace(
    "import kotlinx.coroutines.launch",
    "import kotlinx.coroutines.launch\nimport com.journeyapps.barcodescanner.ScanContract\nimport com.journeyapps.barcodescanner.ScanOptions\nimport com.journeyapps.barcodescanner.ScanIntentResult"
)

scannerLogic = """
    private val barcodeLauncher = registerForActivityResult(ScanContract()) { result: ScanIntentResult ->
        if (result.contents != null) {
            tokenInput.setText(result.contents)
            Toast.makeText(this, "Scanned: " + result.contents, Toast.LENGTH_SHORT).show()
        }
    }
"""

content = content.replace(
    "private var currentOwner: String = \"\"",
    "private var currentOwner: String = \"\"" + scannerLogic
)

scanBtnLayout = """
        val btnScan = Button(this).apply {
            text = "Scan QR Code"
            setOnClickListener {
                val options = ScanOptions()
                options.setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                options.setPrompt("Scan PC Agent QR Code")
                options.setBeepEnabled(true)
                options.setBarcodeImageEnabled(true)
                barcodeLauncher.launch(options)
            }
        }
        layout.addView(btnScan)
"""

content = content.replace(
    "layout.addView(tokenInput)",
    "layout.addView(tokenInput)\n" + scanBtnLayout
)

with open(file, "w", encoding="utf-8") as f:
    f.write(content)

print("Updated MainActivity.kt")

