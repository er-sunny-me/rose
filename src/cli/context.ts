import type { LiveSessionController } from '../voice/live-session.js';

/**
 * Everything a slash-command handler may touch from the host application.
 * Command modules receive this context instead of owning global state, which
 * keeps them independently instantiable and unit-testable.
 */
export interface CliContext {
  // Conversation/session state
  getChatHistory(): any[];
  setChatHistory(messages: any[]): void;
  getAttachments(): string[];
  setAttachments(paths: string[]): void;
  getSessionLabel(): string;
  setSessionLabel(id: string): void;
  switchSession(id: string): void;
  clearCurrentSessionContext(): void;

  // Runtime accessors
  readonly taskExecutor: { getActiveTask(): any; cancelTask(): void; executeTask(...args: any[]): Promise<any> };
  readonly contextManager: {
    buildContext(input: any): Promise<any>;
    compactConversation(history: any[]): Promise<any>;
  };

  // Voice subsystem
  readonly voice: LiveSessionController;
  isVoiceMode(): boolean;
  setVoiceMode(enabled: boolean): void;

  /**
   * Route a user turn through the full chat pipeline over the Live API
   * (falls back to SDK automatically when not connected).
   */
  sendLiveTurn(message: string): Promise<void>;

  // Application controls
  shutdown(): void;
}

/** Parsed command invocation passed to every handler. */
export interface CommandArgs {
  /** Lowercased first token, e.g. `/memory`. */
  cmd: string;
  /** Second token (may be undefined), e.g. `search`. */
  arg?: string;
  /** All whitespace-split tokens of the raw command. */
  parts: string[];
  /** The raw command line as typed by the user. */
  raw: string;
}

export type CommandHandler = (ctx: CliContext, args: CommandArgs) => Promise<boolean | void> | boolean | void;

export interface CommandEntry {
  /** Slash tokens this handler serves. */
  commands: string[];
  description?: string;
  run: CommandHandler;
}
