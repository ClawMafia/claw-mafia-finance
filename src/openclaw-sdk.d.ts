/**
 * Minimal ambient type declarations for openclaw/plugin-sdk/core.
 *
 * OpenClaw resolves this module at runtime via a jiti alias — no package
 * dependency is needed. This file exists only so TypeScript can type-check
 * our plugin code locally without pulling in all of openclaw's source tree.
 *
 * Keep this in sync with:
 *   openclaw/src/plugins/types.ts  → OpenClawPluginApi
 *   openclaw/src/agents/tools/common.ts → AnyAgentTool shape
 */

declare module "openclaw/plugin-sdk/core" {
  /** Tool result shape returned by execute. */
  export interface AgentToolResult {
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    isError?: boolean;
  }

  /**
   * A registered agent tool.
   * - `parameters`: JSON Schema object (use @sinclair/typebox or plain object)
   * - `execute(toolCallId, params)`: toolCallId is the LLM call id; params is the parsed input
   */
  export interface AnyAgentTool {
    name: string;
    description: string;
    label?: string;
    parameters?: Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (toolCallId: string, params: any) => Promise<any>;
  }

  /** Structured logger injected by OpenClaw into each plugin. */
  export interface PluginLogger {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  }

  /** Subset of the plugin API surface that claw-mafia-finance actually uses. */
  export type OpenClawPluginApi = {
    /** Unique plugin id from the manifest. */
    id: string;
    /** Plugin display name. */
    name: string;
    /** Optional per-plugin config block from openclaw.json plugins.entries.<id>.config */
    pluginConfig?: Record<string, unknown>;
    /** Structured logger. */
    logger: PluginLogger;
    /** Register an agent tool so it is available to agents in this OpenClaw instance. */
    registerTool: (tool: AnyAgentTool, opts?: { agentIds?: string[]; optional?: boolean; name?: string; names?: string[] }) => void;
    /** Resolve a path relative to the plugin's data directory. */
    resolvePath: (input: string) => string;
  };
}
