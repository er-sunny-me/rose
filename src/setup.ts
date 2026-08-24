/**
 * DEPRECATED since Phase 33.
 *
 * The questionnaire-style wizard was replaced by the full-screen Rose Setup
 * TUI (`rose setup`). This shim keeps any external imports of
 * `runSetupWizard` working by delegating to the new experience.
 */
export async function runSetupWizard(): Promise<void> {
    const { runSetupCommand } = await import('./setup/index.js');
    await runSetupCommand({});
}
