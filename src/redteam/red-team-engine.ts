import { createHash } from "node:crypto";
import {
  AgentMap,
  Finding,
  RedTeamExecutorMode,
  RedTeamMode,
  RedTeamRun,
  RedTeamStrategy
} from "../core/types.js";
import { inspectAgent } from "../inspect/agent-detector.js";
import {
  defaultAttemptsForMode,
  defaultDepthForMode,
  defaultStrategyForMode,
  planAttackAttempts
} from "./attack-search.js";
import { executeAttackPlans } from "./local-executor.js";
import { judgeRedTeamOutput } from "./judge.js";
import { redTeamCasesToFindings, computeRunStats, reduceCasesWithAttempts } from "./reducer.js";
import { planRedTeamScenarios } from "./scenario-planner.js";
import { profileRedTeamSurfaces } from "./surface-profiler.js";

export type RedTeamOptions = {
  objective?: string;
  mode?: RedTeamMode;
  strategy?: RedTeamStrategy;
  maxCases?: number;
  maxAttemptsPerCase?: number;
  maxDepth?: number;
  includeTerminalChecks?: boolean;
  executor?: RedTeamExecutorMode;
  runId?: string;
};

export type RedTeamExecution = {
  agentMap: AgentMap;
  redTeam: RedTeamRun;
  findings: Finding[];
};

export { judgeRedTeamOutput, redTeamCasesToFindings };

export async function runRedTeamAgent(cwd: string, options: RedTeamOptions = {}): Promise<RedTeamExecution> {
  const mode = normalizeMode(options.mode);
  const strategy = normalizeStrategy(mode, options.strategy);
  const executor = normalizeExecutor(options.executor);
  const maxCases = normalizeMaxCases(mode, options.maxCases);
  const maxAttemptsPerCase = normalizeMaxAttempts(mode, options.maxAttemptsPerCase);
  const maxDepth = normalizeMaxDepth(mode, options.maxDepth);
  const runId = options.runId ?? createHash("sha256").update(`${cwd}:${Date.now()}`).digest("hex").slice(0, 10);
  const canary = `AGENTBLAST_CANARY_${runId.replace(/[^A-Za-z0-9]/g, "_").slice(0, 32)}`;
  const includeTerminalChecks = options.includeTerminalChecks ?? false;

  const agentMap = await inspectAgent(cwd);
  const profile = await profileRedTeamSurfaces(cwd, agentMap);
  const plannedCases = planRedTeamScenarios(profile, { mode, canary, includeTerminalChecks }).slice(0, maxCases);
  const attemptsByCase = planAttackAttempts(plannedCases, {
    mode,
    strategy,
    maxAttemptsPerCase,
    maxDepth,
    canary
  });
  const executedByCase = await executeAttackPlans(cwd, plannedCases, attemptsByCase, { executor });
  const cases = reduceCasesWithAttempts(plannedCases, executedByCase, { canary });
  const stats = computeRunStats({ cases });
  const redTeam: RedTeamRun = {
    id: runId,
    generatedAt: new Date().toISOString(),
    mode,
    strategy,
    executor,
    objective: options.objective,
    includeTerminalChecks,
    maxAttemptsPerCase,
    maxDepth,
    cases,
    ...stats
  };

  return {
    agentMap,
    redTeam,
    findings: redTeamCasesToFindings(redTeam)
  };
}

function normalizeMode(mode: RedTeamMode | undefined): RedTeamMode {
  return mode === "standard" || mode === "deep" ? mode : "quick";
}

function normalizeStrategy(mode: RedTeamMode, strategy: RedTeamStrategy | undefined): RedTeamStrategy {
  if (strategy === "deterministic" || strategy === "fuzz" || strategy === "tree_search" || strategy === "hybrid") return strategy;
  return defaultStrategyForMode(mode);
}

function normalizeExecutor(executor: RedTeamExecutorMode | undefined): RedTeamExecutorMode {
  if (executor === "static" || executor === "emulated" || executor === "local_command" || executor === "local_http") return executor;
  return "auto";
}

function normalizeMaxCases(mode: RedTeamMode, maxCases: number | undefined): number {
  const fallback = mode === "deep" ? 100 : mode === "standard" ? 40 : 12;
  if (typeof maxCases !== "number" || !Number.isFinite(maxCases)) return fallback;
  return Math.min(fallback, Math.max(1, Math.floor(maxCases)));
}

function normalizeMaxAttempts(mode: RedTeamMode, maxAttemptsPerCase: number | undefined): number {
  const fallback = defaultAttemptsForMode(mode);
  if (typeof maxAttemptsPerCase !== "number" || !Number.isFinite(maxAttemptsPerCase)) return fallback;
  return Math.min(24, Math.max(1, Math.floor(maxAttemptsPerCase)));
}

function normalizeMaxDepth(mode: RedTeamMode, maxDepth: number | undefined): number {
  const fallback = defaultDepthForMode(mode);
  if (typeof maxDepth !== "number" || !Number.isFinite(maxDepth)) return fallback;
  return Math.min(6, Math.max(1, Math.floor(maxDepth)));
}
