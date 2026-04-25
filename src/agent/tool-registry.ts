import { AgentMap, Finding, RedTeamExecutorMode, RedTeamMode, RedTeamStrategy } from "../core/types.js";
import { AgentModelTool } from "../codex/codex-responses-client.js";
import { inspectAgent } from "../inspect/agent-detector.js";
import { generateFindings } from "../scan/finding-engine.js";
import { discoverFiles, safeReadFileDetailed, searchCode } from "../tools/repo-tools.js";
import { runTerminalCommand } from "../tools/terminal-tools.js";
import { runRedTeamAgent } from "../redteam/red-team-engine.js";

export type AgentToolContext = {
  cwd: string;
};

export type AgentToolResult = {
  ok: boolean;
  content: unknown;
  summary: string;
};

export type AgentToolDefinition<TInput = Record<string, unknown>> = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: TInput, context: AgentToolContext): Promise<AgentToolResult>;
};

export type AgentToolCallRecord = {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  summary: string;
};

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition>();

  register(tool: AgentToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  list(): AgentToolDefinition[] {
    return Array.from(this.tools.values());
  }

  toModelTools(): AgentModelTool[] {
    return this.list().map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }));
  }

  describeForPrompt(): string {
    return this.list()
      .map((tool) =>
        [
          `Tool: ${tool.name}`,
          `Description: ${tool.description}`,
          `Input JSON schema: ${JSON.stringify(tool.inputSchema)}`
        ].join("\n")
      )
      .join("\n\n");
  }

  async execute(name: string, input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        content: { error: `Unknown tool: ${name}` },
        summary: `Unknown tool: ${name}`
      };
    }
    try {
      return await tool.execute(input, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        content: { error: message },
        summary: `${name} failed: ${message}`
      };
    }
  }
}

export function createDefaultToolRegistry(): AgentToolRegistry {
  const registry = new AgentToolRegistry();

  registry.register({
    name: "list_files",
    description: "List files under the opened codebase. Use this first when you do not know the project structure.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum files to return. Default 120." }
      }
    },
    async execute(input, context) {
      const limit = readNumber(input, "limit", 120, 1, 500);
      const files = (await discoverFiles(context.cwd)).slice(0, limit).map((file) => file.path);
      return {
        ok: true,
        content: { files },
        summary: `Listed ${files.length} files.`
      };
    }
  });

  registry.register({
    name: "search_code",
    description: "Search the opened codebase with ripgrep. Use this to find routes, prompts, tools, model calls, and security-relevant code.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Literal or regex query for rg." },
        limit: { type: "number", description: "Maximum matches to return. Default 40." },
        literal: { type: "boolean", description: "Use literal matching instead of regex. Default false." }
      }
    },
    async execute(input, context) {
      const query = readString(input, "query");
      const limit = readNumber(input, "limit", 40, 1, 100);
      const literal = readBoolean(input, "literal", false);
      const matches = (await searchCode(context.cwd, query, { limit, literal })).slice(0, limit);
      return {
        ok: true,
        content: { matches },
        summary: `Found ${matches.length} matches for "${query}".`
      };
    }
  });

  registry.register({
    name: "read_file",
    description: "Read a specific file from the opened codebase. Paths must be relative to the opened directory.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Relative file path to read." },
        offset: { type: "number", description: "1-indexed line number to start reading from. Default 1." },
        limit: { type: "number", description: "Maximum lines to read. Default 400, max 2000." }
      }
    },
    async execute(input, context) {
      const filePath = readString(input, "path");
      const offset = readNumber(input, "offset", 1, 1, 1_000_000);
      const limit = readNumber(input, "limit", 400, 1, 2_000);
      const file = await safeReadFileDetailed(context.cwd, filePath, { offset, limit });
      return {
        ok: true,
        content: file,
        summary: `Read ${filePath} lines ${file.startLine}-${file.endLine}${file.truncated ? " (truncated)" : ""}.`
      };
    }
  });

  registry.register({
    name: "run_terminal_command",
    description:
      "Run a local bash command inside the opened codebase for inspection, tests, typechecks, and diagnostics. Destructive, network, credential-reading, package-install, and source-mutating commands are blocked by policy.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "Bash command to run." },
        workdir: { type: "string", description: "Optional relative workdir inside the opened directory. Default '.'." },
        timeoutMs: { type: "number", description: "Timeout in milliseconds. Default 120000, max 600000." },
        maxOutputBytes: { type: "number", description: "Maximum stdout/stderr bytes to return. Default 80000, max 250000." }
      },
      additionalProperties: false
    },
    async execute(input, context) {
      const command = readString(input, "command");
      const result = await runTerminalCommand(context.cwd, {
        command,
        workdir: readOptionalString(input, "workdir"),
        timeoutMs: readOptionalNumber(input, "timeoutMs"),
        maxOutputBytes: readOptionalNumber(input, "maxOutputBytes")
      });
      return {
        ok: result.policy.allowed && result.exitCode === 0 && !result.timedOut,
        content: result,
        summary: result.policy.allowed
          ? `Command exited ${result.exitCode} in ${result.durationMs}ms${result.timedOut ? " (timed out)" : ""}: ${command}`
          : `Blocked command: ${result.policy.reason}`
      };
    }
  });

  registry.register({
    name: "inspect_agent",
    description: "Run Agent Blast's deterministic agent surface detector over the opened codebase.",
    inputSchema: { type: "object", properties: {} },
    async execute(_input, context) {
      const agentMap: AgentMap = await inspectAgent(context.cwd);
      return {
        ok: true,
        content: { agentMap },
        summary: `Detected ${agentMap.entrypoints.length} entrypoints, ${agentMap.modelCalls.length} model calls, ${agentMap.tools.length} tools, ${agentMap.retrieval.length} retrieval surfaces.`
      };
    }
  });

  registry.register({
    name: "scan_findings",
    description: "Generate deterministic Agent Blast findings from the current codebase inspection.",
    inputSchema: { type: "object", properties: {} },
    async execute(_input, context) {
      const agentMap = await inspectAgent(context.cwd);
      const findings: Finding[] = generateFindings(agentMap);
      return {
        ok: true,
        content: { agentMap, findings },
        summary: `Generated ${findings.length} findings.`
      };
    }
  });

  registry.register({
    name: "red_team_agent",
    description:
      "Run Agent Blast's bounded local red-team harness against detected AI-agent surfaces. Generates replayable prompt-injection, tool-misuse, data-boundary, retrieval, memory, and terminal-contamination cases using synthetic canaries only.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "Optional defensive objective for the red-team run." },
        mode: { type: "string", enum: ["quick", "standard", "deep"], description: "Run depth. Defaults to quick." },
        strategy: {
          type: "string",
          enum: ["deterministic", "fuzz", "tree_search", "hybrid"],
          description: "Attack-search strategy. Defaults by mode: quick deterministic, standard fuzz, deep hybrid."
        },
        maxCases: { type: "number", description: "Maximum cases to generate. Defaults: quick 12, standard 40, deep 100." },
        maxAttemptsPerCase: {
          type: "number",
          description: "Maximum active attempts per case. Defaults: quick 1, standard 5, deep 12."
        },
        maxDepth: {
          type: "number",
          description: "Maximum tree-search depth. Defaults: quick 1, standard 2, deep 4."
        },
        executor: {
          type: "string",
          enum: ["auto", "static", "emulated", "local_command", "local_http"],
          description: "Execution backend. auto uses bounded emulated/local probes unless a dedicated local harness is selected."
        },
        includeTerminalChecks: {
          type: "boolean",
          description: "When true, includes a local terminal policy probe that blocks remote/network commands and permits harmless local diagnostics."
        }
      },
      additionalProperties: false
    },
    async execute(input, context) {
      const mode = readOptionalMode(input, "mode");
      const execution = await runRedTeamAgent(context.cwd, {
        objective: readOptionalString(input, "objective"),
        mode,
        strategy: readOptionalStrategy(input, "strategy"),
        maxCases: readOptionalNumber(input, "maxCases"),
        maxAttemptsPerCase: readOptionalNumber(input, "maxAttemptsPerCase"),
        maxDepth: readOptionalNumber(input, "maxDepth"),
        executor: readOptionalExecutor(input, "executor"),
        includeTerminalChecks: readBoolean(input, "includeTerminalChecks", false)
      });
      return {
        ok: true,
        content: execution,
        summary: `Red-team generated ${execution.redTeam.cases.length} cases and ${execution.redTeam.attempts ?? 0} attempts: ${execution.redTeam.failed} failed, ${execution.redTeam.passed} passed, ${execution.redTeam.needsReview} needs review.`
      };
    }
  });

  return registry;
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Tool input field "${key}" must be a non-empty string.`);
  }
  return value;
}

function readNumber(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function readOptionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === "boolean" ? value : fallback;
}

function readOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalMode(input: Record<string, unknown>, key: string): RedTeamMode | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === "quick" || value === "standard" || value === "deep") return value;
  throw new Error(`Tool input field "${key}" must be one of: quick, standard, deep.`);
}

function readOptionalStrategy(input: Record<string, unknown>, key: string): RedTeamStrategy | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === "deterministic" || value === "fuzz" || value === "tree_search" || value === "hybrid") return value;
  throw new Error(`Tool input field "${key}" must be one of: deterministic, fuzz, tree_search, hybrid.`);
}

function readOptionalExecutor(input: Record<string, unknown>, key: string): RedTeamExecutorMode | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === "auto" || value === "static" || value === "emulated" || value === "local_command" || value === "local_http") return value;
  throw new Error(`Tool input field "${key}" must be one of: auto, static, emulated, local_command, local_http.`);
}
