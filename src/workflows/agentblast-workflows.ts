import { CodexResponsesClient } from "../codex/codex-responses-client.js";
import { runAgentLoop } from "../agent/agent-loop.js";
import { CodexAgentModelClient } from "../agent/model-client.js";
import { AgentBlastWorkspace } from "../core/workspace.js";
import { AgentBlastRun, Finding, PatchProposal, ReplayResult, WorkflowResult } from "../core/types.js";
import { inspectAgent } from "../inspect/agent-detector.js";
import { generateFindings } from "../scan/finding-engine.js";
import { applyPatchProposal, proposePatches } from "../patch/patch-manager.js";
import { renderHtmlReport, renderMarkdownReport } from "../report/report-writer.js";
import { RedTeamOptions, runRedTeamAgent } from "../redteam/red-team-engine.js";
import { annotateReplayPatchValidation } from "../redteam/reducer.js";

export class AgentBlastWorkflows {
  readonly cwd: string;
  readonly model: string;
  readonly workspace: AgentBlastWorkspace;
  readonly codex: CodexResponsesClient;
  private currentRun?: AgentBlastRun;

  constructor(input: { cwd: string; model: string; codex?: CodexResponsesClient }) {
    this.cwd = input.cwd;
    this.model = input.model;
    this.workspace = new AgentBlastWorkspace({ cwd: input.cwd, model: input.model });
    this.codex = input.codex ?? new CodexResponsesClient({ model: input.model, timeoutMs: 180_000 });
  }

  async init(): Promise<WorkflowResult> {
    await this.workspace.init();
    return { message: "Initialized .agentblast workspace." };
  }

  async inspect(): Promise<WorkflowResult> {
    await this.workspace.init();
    const agentMap = await inspectAgent(this.cwd);
    await this.workspace.writeAgentMap(agentMap);
    return {
      message: `Inspection complete: ${agentMap.entrypoints.length} entrypoints, ${agentMap.modelCalls.length} model calls, ${agentMap.tools.length} tools, ${agentMap.retrieval.length} retrieval surfaces.`,
      agentMap
    };
  }

  async scan(): Promise<WorkflowResult> {
    await this.workspace.init();
    const agentMap = await inspectAgent(this.cwd);
    await this.workspace.writeAgentMap(agentMap);
    const findings = generateFindings(agentMap);
    const run = await this.workspace.createRun({ agentMap, findings });
    this.currentRun = run;
    return {
      message: `Scan complete: ${findings.length} findings created in run ${run.id}.`,
      agentMap,
      findings,
      run
    };
  }

  async harden(): Promise<WorkflowResult> {
    const run = await this.requireRun();
    const agentMap = run.agentMap ?? (await inspectAgent(this.cwd));
    const patches = await proposePatches(this.cwd, agentMap, run.findings);
    const nextFindings = run.findings.map((finding) =>
      patches.some((patch) => patch.findingId === finding.id) ? { ...finding, status: "patch_proposed" as const } : finding
    );
    const nextRun = { ...run, agentMap, findings: nextFindings, patches };
    for (const patch of patches) {
      await this.workspace.writePatchFile(run.id, patch);
    }
    await this.workspace.writeRun(nextRun);
    this.currentRun = nextRun;
    return {
      message: patches.length > 0 ? `Prepared ${patches.length} patch proposal. Use /apply to confirm source edits.` : "No safe automatic patch proposal was generated.",
      run: nextRun,
      patches
    };
  }

  async applyFirstPatch(): Promise<WorkflowResult> {
    const run = await this.requireRun();
    const pending = run.patches.find((patch) => patch.status === "proposed");
    if (!pending) return { message: "No proposed patch is waiting for confirmation.", run };
    const applied = await applyPatchProposal(this.cwd, pending);
    const patches = run.patches.map((patch) => (patch.id === applied.id ? applied : patch));
    const nextRun = { ...run, patches };
    await this.workspace.writeRun(nextRun);
    this.currentRun = nextRun;
    return {
      message: applied.status === "applied" ? `Applied ${applied.id} to ${applied.targetPath}.` : `Patch ${applied.id} failed git apply validation.`,
      run: nextRun,
      patches
    };
  }

  async replay(): Promise<WorkflowResult> {
    const run = await this.requireRun();
    const agentMap = await inspectAgent(this.cwd);
    const after = generateFindings(agentMap);
    const remainingKeys = new Set(after.map(findingReplayKey));
    const staticFindings = run.findings.filter((finding) => !finding.id.startsWith("RTF-"));
    const fixedFindingIds = staticFindings.filter((finding) => !remainingKeys.has(findingReplayKey(finding))).map((finding) => finding.id);
    const remainingFindingIds = staticFindings.filter((finding) => remainingKeys.has(findingReplayKey(finding))).map((finding) => finding.id);
    const redTeamAfter = run.redTeam
      ? (
          await runRedTeamAgent(this.cwd, {
            mode: run.redTeam.mode,
            maxCases: run.redTeam.cases.length,
            strategy: run.redTeam.strategy,
            maxAttemptsPerCase: run.redTeam.maxAttemptsPerCase,
            maxDepth: run.redTeam.maxDepth,
            executor: run.redTeam.executor,
            includeTerminalChecks: run.redTeam.includeTerminalChecks,
            objective: run.redTeam.objective,
            runId: run.id
          })
        ).redTeam
      : undefined;
    const beforeFailedRedTeamIds = new Set((run.redTeam?.cases ?? []).filter((testCase) => testCase.result === "failed").map((testCase) => testCase.id));
    const annotatedRedTeamAfter = redTeamAfter ? annotateReplayPatchValidation(redTeamAfter, beforeFailedRedTeamIds) : undefined;
    const afterFailedRedTeamIds = new Set((annotatedRedTeamAfter?.cases ?? []).filter((testCase) => testCase.result === "failed").map((testCase) => testCase.id));
    const replay: ReplayResult = {
      runId: run.id,
      generatedAt: new Date().toISOString(),
      findingsBefore: staticFindings.length,
      findingsAfter: after.length,
      fixedFindingIds,
      remainingFindingIds,
      redTeamCasesBefore: run.redTeam?.cases.length,
      redTeamCasesAfter: redTeamAfter?.cases.length,
      fixedRedTeamCaseIds: [...beforeFailedRedTeamIds].filter((caseId) => !afterFailedRedTeamIds.has(caseId)),
      remainingRedTeamCaseIds: [...beforeFailedRedTeamIds].filter((caseId) => afterFailedRedTeamIds.has(caseId)),
      redTeamAttackSuccessRateBefore: run.redTeam?.attackSuccessRate,
      redTeamAttackSuccessRateAfter: annotatedRedTeamAfter?.attackSuccessRate
    };
    const nextRun = await this.workspace.writeReplay({ ...run, agentMap, redTeam: annotatedRedTeamAfter ?? run.redTeam }, replay);
    this.currentRun = nextRun;
    return {
      message: run.redTeam
        ? `Replay complete: ${fixedFindingIds.length} static fixed, ${remainingFindingIds.length} static remaining; ${replay.fixedRedTeamCaseIds?.length ?? 0} red-team cases fixed, ${replay.remainingRedTeamCaseIds?.length ?? 0} still failing.`
        : `Replay complete: ${fixedFindingIds.length} fixed, ${remainingFindingIds.length} remaining.`,
      replay,
      run: nextRun
    };
  }

  async redteam(options: RedTeamOptions = {}): Promise<WorkflowResult> {
    await this.workspace.init();
    const run = this.currentRun ?? (await this.scan()).run;
    if (!run) throw new Error("Unable to create Agent Blast run for red-team execution.");
    const execution = await runRedTeamAgent(this.cwd, { ...options, runId: run.id });
    await this.workspace.writeAgentMap(execution.agentMap);
    const findings = mergeFindings(run.findings, execution.findings);
    const nextRun = {
      ...run,
      agentMap: execution.agentMap,
      findings,
      redTeam: execution.redTeam
    };
    await this.workspace.writeRun(nextRun);
    this.currentRun = nextRun;
    return {
      message: `Red-team suite complete: ${execution.redTeam.failed} failed, ${execution.redTeam.passed} passed, ${execution.redTeam.needsReview} needs review, ${execution.redTeam.notApplicable} not applicable.`,
      agentMap: execution.agentMap,
      findings,
      redTeam: execution.redTeam,
      run: nextRun
    };
  }

  async report(): Promise<WorkflowResult> {
    const run = await this.requireRun();
    const report = renderMarkdownReport(run);
    const html = renderHtmlReport(run);
    const paths = await this.workspace.writeReport(run.id, report, html);
    return {
      message: `Report written to ${paths.runReportPath}, ${paths.htmlReportPath}, and ${paths.latestReportPath}.`,
      run
    };
  }

  async ask(question: string): Promise<WorkflowResult> {
    await this.workspace.init();
    const result = await runAgentLoop({
      cwd: this.cwd,
      model: this.model,
      userRequest: question,
      modelClient: new CodexAgentModelClient(this.codex)
    });
    return {
      message: result.answer,
      toolEvents: result.toolCalls.map((call) => `${call.ok ? "ok" : "failed"} ${call.tool}: ${call.summary}`)
    };
  }

  getCurrentRun(): AgentBlastRun | undefined {
    return this.currentRun;
  }

  private async requireRun(): Promise<AgentBlastRun> {
    if (this.currentRun) return this.currentRun;
    const scan = await this.scan();
    if (!scan.run) throw new Error("Unable to create Agent Blast run.");
    return scan.run;
  }
}

function mergeFindings(existing: Finding[], incoming: Finding[]): Finding[] {
  const byId = new Map(existing.map((finding) => [finding.id, finding]));
  for (const finding of incoming) {
    byId.set(finding.id, finding);
  }
  return Array.from(byId.values());
}

function findingReplayKey(finding: Finding): string {
  return [finding.category, finding.file ?? "", finding.title].join("::");
}
