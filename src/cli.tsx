#!/usr/bin/env node

import path from "node:path";
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { DEFAULT_CODEX_MODEL } from "./codex/codex-oauth-client.js";
import { CodexResponsesClient } from "./codex/codex-responses-client.js";
import { resolveTargetCwd } from "./core/paths.js";
import { AgentBlastApp } from "./ui/AgentBlastApp.js";
import { AgentBlastWorkflows } from "./workflows/agentblast-workflows.js";

const program = new Command();

program
  .name("agentblast")
  .description("Agent Blast: local defensive red-team and hardening CLI for AI agents.")
  .option("-C, --cwd <path>", "Target codebase directory", process.cwd())
  .option("-m, --model <model>", "Codex model", process.env.AGENTBLAST_CODEX_MODEL ?? DEFAULT_CODEX_MODEL)
  .action((options: GlobalOptions) => {
    launchTui(options);
  });

const codex = program.command("codex").description("Codex OAuth diagnostics");

codex.command("status").description("Check Codex OAuth login status").action(async () => {
  const options = program.opts<GlobalOptions>();
  const client = new CodexResponsesClient({ model: options.model });
  const status = await client.getAuthStatus();
  console.log(JSON.stringify(status, null, 2));
});

codex
  .command("smoke")
  .description("Run a live gpt-5.5 Codex OAuth smoke test")
  .option("-m, --model <model>", "Codex model", process.env.AGENTBLAST_CODEX_MODEL ?? DEFAULT_CODEX_MODEL)
  .action(async (options: { model: string }) => {
    const globalOptions = program.opts<GlobalOptions>();
    const model = options.model ?? globalOptions.model;
    const client = new CodexResponsesClient({ model });
    const expected = { ok: true, model, auth: "codex-oauth", tool: "agentblast_probe" };
    await client.assertChatGptOAuth();
    const first = await client.call({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are validating AgentBlast native Codex OAuth tool calling. First call agentblast_probe with probe='agentblast-native-tool-call'. After the tool output exists, return exactly the expected JSON."
        },
        { role: "user", content: "Run the validation probe." }
      ],
      tools: [probeTool()]
    });
    const probe = first.toolCalls[0];
    if (!probe || probe.name !== "agentblast_probe") {
      throw new Error(`Expected a native function call to agentblast_probe, got: ${JSON.stringify(first)}`);
    }
    const second = await client.call({
      model,
      messages: [
        {
          role: "system",
          content: `Return exactly this JSON and nothing else after reading the tool output: ${JSON.stringify(expected)}`
        },
        { role: "user", content: "Run the validation probe." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: probe.id,
              type: "function",
              function: { name: probe.name, arguments: probe.arguments }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: probe.id,
          content: JSON.stringify({ ok: true, probe: "agentblast-native-tool-call" })
        }
      ],
      tools: [probeTool()]
    });
    const parsed = parseJsonObject(second.content);

    if (parsed.ok !== true || parsed.model !== model || parsed.auth !== "codex-oauth" || parsed.tool !== "agentblast_probe") {
      throw new Error(`Unexpected Codex smoke response: ${second.content}`);
    }

    console.log(JSON.stringify({ ok: true, model, auth: "codex-oauth", nativeTools: true, message: parsed }, null, 2));
  });

program.command("inspect").description("Run non-interactive inspection").option("--json", "Print JSON").action(async (options: { json?: boolean }) => {
  const globalOptions = program.opts<GlobalOptions>();
  const workflows = createWorkflows(globalOptions);
  const result = await workflows.inspect();
  if (options.json) {
    console.log(JSON.stringify(result.agentMap, null, 2));
  } else {
    console.log(result.message);
  }
});

program.command("scan").description("Run non-interactive scan").option("--json", "Print JSON").action(async (options: { json?: boolean }) => {
  const globalOptions = program.opts<GlobalOptions>();
  const workflows = createWorkflows(globalOptions);
  const result = await workflows.scan();
  if (options.json) {
    console.log(JSON.stringify(result.run, null, 2));
  } else {
    console.log(result.message);
  }
});

program
  .command("redteam")
  .description("Run bounded local red-team cases against detected agent surfaces")
  .option("--mode <mode>", "Run depth: quick, standard, or deep", "quick")
  .option("--strategy <strategy>", "Attack strategy: deterministic, fuzz, tree_search, or hybrid")
  .option("--max-cases <count>", "Maximum cases to generate")
  .option("--max-attempts-per-case <count>", "Maximum active attempts per case")
  .option("--max-depth <count>", "Maximum tree-search depth")
  .option("--executor <executor>", "Executor: auto, static, emulated, local_command, or local_http")
  .option("--include-terminal-checks", "Include AgentBlast terminal policy checks")
  .option("--objective <objective>", "Optional defensive red-team objective")
  .option("--json", "Print JSON")
  .action(async (options: {
    mode: string;
    strategy?: string;
    maxCases?: string;
    maxAttemptsPerCase?: string;
    maxDepth?: string;
    executor?: string;
    includeTerminalChecks?: boolean;
    objective?: string;
    json?: boolean;
  }) => {
    const globalOptions = program.opts<GlobalOptions>();
    const workflows = createWorkflows(globalOptions);
    const result = await workflows.redteam({
      mode: parseMode(options.mode),
      strategy: options.strategy ? parseStrategy(options.strategy) : undefined,
      maxCases: options.maxCases ? Number(options.maxCases) : undefined,
      maxAttemptsPerCase: options.maxAttemptsPerCase ? Number(options.maxAttemptsPerCase) : undefined,
      maxDepth: options.maxDepth ? Number(options.maxDepth) : undefined,
      executor: options.executor ? parseExecutor(options.executor) : undefined,
      includeTerminalChecks: options.includeTerminalChecks,
      objective: options.objective
    });
    if (options.json) {
      console.log(JSON.stringify(result.redTeam, null, 2));
    } else {
      console.log(result.message);
    }
  });

program.command("report").description("Write report for a fresh scan").action(async () => {
  const globalOptions = program.opts<GlobalOptions>();
  const workflows = createWorkflows(globalOptions);
  await workflows.scan();
  const result = await workflows.report();
  console.log(result.message);
});

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

type GlobalOptions = {
  cwd: string;
  model: string;
};

function launchTui(options: GlobalOptions): void {
  const cwd = resolveTargetCwd(path.resolve(options.cwd));
  render(<AgentBlastApp cwd={cwd} model={options.model} />);
}

function createWorkflows(options: GlobalOptions): AgentBlastWorkflows {
  return new AgentBlastWorkflows({
    cwd: resolveTargetCwd(path.resolve(options.cwd)),
    model: options.model
  });
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object, got: ${value}`);
  }
  return parsed as Record<string, unknown>;
}

function parseMode(value: string): "quick" | "standard" | "deep" {
  if (value === "quick" || value === "standard" || value === "deep") return value;
  throw new Error(`Invalid redteam mode: ${value}`);
}

function parseStrategy(value: string): "deterministic" | "fuzz" | "tree_search" | "hybrid" {
  if (value === "deterministic" || value === "fuzz" || value === "tree_search" || value === "hybrid") return value;
  throw new Error(`Invalid redteam strategy: ${value}`);
}

function parseExecutor(value: string): "auto" | "static" | "emulated" | "local_command" | "local_http" {
  if (value === "auto" || value === "static" || value === "emulated" || value === "local_command" || value === "local_http") return value;
  throw new Error(`Invalid redteam executor: ${value}`);
}

function probeTool() {
  return {
    type: "function" as const,
    function: {
      name: "agentblast_probe",
      description: "Validation probe for AgentBlast native tool calling.",
      parameters: {
        type: "object",
        properties: {
          probe: { type: "string" }
        },
        required: ["probe"],
        additionalProperties: false
      }
    }
  };
}
