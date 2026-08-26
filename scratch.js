
const fs = require("fs");
const file = "mobile/app/src/main/java/ai/rose/mesh/MainActivity.kt";
let content = fs.readFileSync(file, "utf8");

content = content.replace(
    "import kotlinx.coroutines.launch",
    `import kotlinx.coroutines.launch
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.journeyapps.barcodescanner.ScanIntentResult`
);

const scannerLogic = `
    private val barcodeLauncher = registerForActivityResult(ScanContract()) { result: ScanIntentResult ->
        if (result.contents != null) {
            tokenInput.setText(result.contents)
            Toast.makeText(this, "Scanned: " + result.contents, Toast.LENGTH_SHORT).show()
        }
    }
`;

content = content.replace(
    "private var currentOwner: String = \"\"",
    "private var currentOwner: String = \"\"" + scannerLogic
);

const scanBtnLayout = `
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
`;

content = content.replace(
    "layout.addView(tokenInput)",
    "layout.addView(tokenInput)\n" + scanBtnLayout
);

fs.writeFileSync(file, content);
console.log("Updated MainActivity.kt");

