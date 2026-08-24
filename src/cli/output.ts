import chalk from 'chalk';

export function displayWelcome(): void {
  console.clear();
  console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║') + chalk.bold.white('  🎙️  Gemini Flash Live - Voice to Voice AI Chat  🤖  ') + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('╚═══════════════════════════════════════════════════════════╝\n'));
  console.log(chalk.yellow('🌟 Model Capabilities:'));
  console.log(chalk.white('  • High-quality, low-latency Audio-to-Audio (A2A)'));
  console.log(chalk.white('  • Real-time voice input and output'));
  console.log(chalk.white('  • Multi-turn conversations with context\n'));
  console.log(chalk.green('📝 Available Commands:'));
  console.log(chalk.white('  /voice    - Enable voice mode (auto-connects to Live API)'));
  console.log(chalk.white('  /text     - Switch back to text-only mode'));
  console.log(chalk.white('  /record   - Start speaking (if continuous listening failed)'));
  console.log(chalk.white('  /stop     - Stop recording and let the AI respond'));
  console.log(chalk.white('  /mic      - List / choose microphone (e.g. /mic 1)'));
  console.log(chalk.white('  /voices   - List available voice options'));
  console.log(chalk.white('  /config   - Show current configuration'));
  console.log(chalk.white('  /clear    - Clear chat history'));
  console.log(chalk.white('  /history  - Show conversation history'));
  console.log(chalk.white('  /save     - Save conversation (text + playable WAV)'));
  console.log(chalk.white('  /help     - Show this help message'));
  console.log(chalk.white('  /exit     - Exit the application\n'));
  console.log(chalk.white('  /extensions - List loaded extensions'));
  console.log(chalk.white('  /mcp      - List connected MCP servers'));
  console.log(chalk.white('  /security - Show Security settings'));
  console.log(chalk.white('  /diagnostics - Show Agent health'));
  console.log(chalk.white('  /models   - Show available models'));
  console.log(chalk.white('  /providers - Show provider health'));
  console.log(chalk.white('  /automations - Show active scheduled tasks'));
  console.log(chalk.white('  /trace    - Show execution trace of last task'));
  console.log(chalk.white('  /last-run - Show metrics of last task'));
  console.log(chalk.white('  /security mode [safe|balanced|autonomous] - Change autonomy mode\n'));
  console.log(chalk.gray('─'.repeat(60)) + '\n');
  console.log(chalk.cyan('💡 Tip: Just type /voice to connect. It will listen automatically!\n'));
}
