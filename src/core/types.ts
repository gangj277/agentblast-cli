export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type AgentBlastConfig = {
  version: 1;
  cwd: string;
  model: string;
  createdAt: string;
};

export type AgentMap = {
  project: {
    root: string;
    language: "typescript" | "javascript" | "mixed" | "unknown";
    framework: "nextjs" | "node" | "unknown";
  };
  entrypoints: AgentSurface[];
  modelCalls: AgentSurface[];
  prompts: AgentSurface[];
  tools: ToolSurface[];
  retrieval: AgentSurface[];
  riskAreas: string[];
  filesScanned: number;
  generatedAt: string;
};

export type AgentSurface = {
  path: string;
  kind: string;
  evidence: string;
};

export type ToolSurface = AgentSurface & {
  name: string;
  sideEffect: boolean;
  requiresApproval: boolean;
};

export type Finding = {
  id: string;
  title: string;
  severity: Severity;
  category: string;
  owasp: string;
  file?: string;
  evidence: string;
  rationale: string;
  recommendedFix: string;
  status: "open" | "patch_proposed" | "fixed" | "accepted_risk";
};

export type PatchProposal = {
  id: string;
  findingId: string;
  title: string;
  targetPath: string;
  rationale: string;
  diff: string;
  status: "proposed" | "applied" | "failed";
};

export type ReplayResult = {
  runId: string;
  generatedAt: string;
  findingsBefore: number;
  findingsAfter: number;
  fixedFindingIds: string[];
  remainingFindingIds: string[];
  redTeamCasesBefore?: number;
  redTeamCasesAfter?: number;
  fixedRedTeamCaseIds?: string[];
  remainingRedTeamCaseIds?: string[];
  redTeamAttackSuccessRateBefore?: number;
  redTeamAttackSuccessRateAfter?: number;
};

export type RedTeamMode = "quick" | "standard" | "deep";
export type RedTeamStrategy = "deterministic" | "fuzz" | "tree_search" | "hybrid";
export type RedTeamExecutorMode = "auto" | "static" | "emulated" | "local_command" | "local_http";

export type RedTeamCaseClass =
  | "direct_prompt_injection"
  | "indirect_prompt_injection"
  | "tool_misuse"
  | "data_exfiltration"
  | "retrieval_poisoning"
  | "memory_persistence"
  | "terminal_contamination"
  | "over_refusal"
  | "utility_security_tradeoff";

export type RedTeamCaseResult = "passed" | "failed" | "needs_review" | "not_applicable";
export type RedTeamAttemptVerdict = "success" | "blocked" | "inconclusive" | "not_executable";
export type RedTeamPatchValidationStatus = "not_run" | "fixed" | "still_failing" | "not_applicable";

export type RedTeamAttempt = {
  id: string;
  caseId: string;
  strategy: string;
  turnCount: number;
  injectedArtifactSummary: string;
  observedTrace: string[];
  judgeVerdict: RedTeamAttemptVerdict;
  judgeRationale: string;
  score: number;
};

export type RedTeamCase = {
  id: string;
  class: RedTeamCaseClass;
  targetPath?: string;
  targetSurface: string;
  invariant: string;
  attackSummary: string;
  observedBehavior: string;
  result: RedTeamCaseResult;
  evidence: string;
  attempts?: RedTeamAttempt[];
  bestAttemptId?: string;
  attackPath?: string[];
  rootCause?: string;
  replayCommand?: string;
  patchValidationStatus?: RedTeamPatchValidationStatus;
};

export type RedTeamRun = {
  id: string;
  generatedAt: string;
  mode: RedTeamMode;
  strategy?: RedTeamStrategy;
  executor?: RedTeamExecutorMode;
  objective?: string;
  includeTerminalChecks: boolean;
  maxAttemptsPerCase?: number;
  maxDepth?: number;
  cases: RedTeamCase[];
  failed: number;
  passed: number;
  needsReview: number;
  notApplicable: number;
  attempts?: number;
  successfulAttempts?: number;
  attackSuccessRate?: number;
};

export type AgentBlastRun = {
  id: string;
  createdAt: string;
  cwd: string;
  agentMap?: AgentMap;
  findings: Finding[];
  patches: PatchProposal[];
  redTeam?: RedTeamRun;
  replay?: ReplayResult;
};

export type TranscriptEvent = {
  id: string;
  role: "user" | "agent" | "tool" | "system" | "error";
  text: string;
  timestamp: string;
};

export type WorkflowResult = {
  message: string;
  agentMap?: AgentMap;
  run?: AgentBlastRun;
  findings?: Finding[];
  patches?: PatchProposal[];
  redTeam?: RedTeamRun;
  replay?: ReplayResult;
  toolEvents?: string[];
};
