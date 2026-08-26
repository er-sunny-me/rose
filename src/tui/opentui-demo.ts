import { TextRenderable, createCliRenderer } from "@opentui/core";
import chalk from "chalk";

export async function runOpenTuiDemo() {
    console.log(chalk.cyan("Launching OpenTUI Sandbox..."));
    console.log(chalk.dim("Press Ctrl+C to exit."));
    
    try {
        const renderer = await createCliRenderer({ exitOnCtrlC: true });
        renderer.root.add(new TextRenderable(renderer, { content: "Hello from OpenTUI natively embedded in Rose!" }));
        
        // Block the function to prevent the script from exiting immediately
        return new Promise<void>((resolve) => {
            // we leave it pending, the user exits with Ctrl+C
        });
    } catch (err: any) {
        console.error(chalk.red(`Failed to launch OpenTUI: ${err.message}`));
    }
}
