import React, { useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  AgentMap,
  Finding,
  PatchProposal,
  RedTeamExecutorMode,
  RedTeamMode,
  RedTeamRun,
  RedTeamStrategy,
  ReplayResult,
  TranscriptEvent
} from "../core/types.js";
import { AgentBlastWorkflows } from "../workflows/agentblast-workflows.js";
import { DEFAULT_CODEX_MODEL } from "../codex/codex-oauth-client.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../core/package-info.js";
import { checkForUpdate, installLatestUpdate, UpdateStatus, updateStatusLabel } from "../update/version-check.js";

type Phase =
  | "idle"
  | "inspect"
  | "scan"
  | "redteam"
  | "harden"
  | "confirm"
  | "apply"
  | "replay"
  | "report"
  | "chat"
  | "update"
  | "error";

export type AgentBlastAppProps = {
  cwd: string;
  model?: string;
  workflows?: AgentBlastWorkflows;
};

type CommandDefinition = {
  name: string;
  usage: string;
  description: string;
};

const COMMANDS: CommandDefinition[] = [
  { name: "/inspect", usage: "/inspect", description: "Map entrypoints, prompts, tools, retrieval" },
  { name: "/scan", usage: "/scan", description: "Create source-grounded findings" },
  { name: "/redteam", usage: "/redteam [quick|standard|deep] [--strategy fuzz|hybrid]", description: "Run local adversarial attempts" },
  { name: "/harden", usage: "/harden", description: "Prepare patch proposals" },
  { name: "/apply", usage: "/apply", description: "Preview and confirm the next patch" },
  { name: "/replay", usage: "/replay", description: "Rerun checks after patching" },
  { name: "/report", usage: "/report", description: "Write Markdown and HTML reports" },
  { name: "/update", usage: "/update", description: "Install the latest Agent Blast CLI release" },
  { name: "/help", usage: "/help", description: "Show command reference" },
  { name: "/quit", usage: "/quit", description: "Exit Agent Blast" }
];

export function AgentBlastApp({ cwd, model = DEFAULT_CODEX_MODEL, workflows: injectedWorkflows }: AgentBlastAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [workflows] = useState(() => injectedWorkflows ?? new AgentBlastWorkflows({ cwd, model }));
  const [phase, setPhase] = useState<Phase>("idle");
  const [input, setInput] = useState("");
  const [oauthStatus, setOauthStatus] = useState("checking");
  const [agentMap, setAgentMap] = useState<AgentMap | undefined>();
  const [findings, setFindings] = useState<Finding[]>([]);
  const [patches, setPatches] = useState<PatchProposal[]>([]);
  const [redTeam, setRedTeam] = useState<RedTeamRun | undefined>();
  const [replay, setReplay] = useState<ReplayResult | undefined>();
  const [pendingApply, setPendingApply] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>();
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    state: "checking",
    packageName: PACKAGE_NAME,
    currentVersion: PACKAGE_VERSION
  });
  const [events, setEvents] = useState<TranscriptEvent[]>(() => [
    event("system", `Agent Blast v${PACKAGE_VERSION} ready. Start with /inspect, then /scan or /redteam standard.`)
  ]);

  React.useEffect(() => {
    let active = true;
    workflows.codex
      .getAuthStatus()
      .then((status) => {
        if (active) setOauthStatus(status.provider === "chatgpt" ? "ChatGPT OAuth" : status.raw || "not ready");
      })
      .catch((error: unknown) => {
        if (active) setOauthStatus(error instanceof Error ? error.message : String(error));
      });
    void workflows.init();
    return () => {
      active = false;
    };
  }, [workflows]);

  React.useEffect(() => {
    let active = true;
    checkForUpdate()
      .then((status) => {
        if (!active) return;
        setUpdateStatus(status);
        if (status.state === "available") {
          addEvent("system", `Update available: ${status.packageName} ${status.currentVersion} -> ${status.latestVersion}. Run /update to install.`);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setUpdateStatus({
          state: "unavailable",
          packageName: PACKAGE_NAME,
          currentVersion: PACKAGE_VERSION,
          error: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString()
        });
      });
    return () => {
      active = false;
    };
  }, []);

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      exit();
      return;
    }

    if (pendingApply) {
      if (value.toLowerCase() === "y") {
        setPendingApply(false);
        void runCommand("/apply-confirmed");
      }
      if (value.toLowerCase() === "n" || key.escape) {
        setPendingApply(false);
        setPhase("idle");
        addEvent("system", "Patch application cancelled. No source files changed.");
      }
      return;
    }

    if (key.return) {
      const submitted = input.trim();
      setInput("");
      setHistoryIndex(undefined);
      if (submitted) {
        setHistory((current) => [...current.filter((item) => item !== submitted).slice(-30), submitted]);
        void runCommand(submitted);
      }
      return;
    }

    if (key.upArrow) {
      setHistoryIndex((current) => {
        const next = current === undefined ? history.length - 1 : Math.max(0, current - 1);
        const item = history[next];
        if (item) setInput(item);
        return item ? next : current;
      });
      return;
    }

    if (key.downArrow) {
      setHistoryIndex((current) => {
        if (current === undefined) return current;
        const next = current + 1;
        const item = history[next];
        setInput(item ?? "");
        return item ? next : undefined;
      });
      return;
    }

    if (value === "\t" || key.tab) {
      const firstSuggestion = suggestionsForInput(input)[0];
      if (firstSuggestion) setInput(firstSuggestion.name);
      return;
    }

    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }

    if (key.escape) {
      setInput("");
      return;
    }

    if (value && !key.ctrl && !key.meta) {
      setInput((current) => `${current}${value}`);
    }
  });

  async function runCommand(command: string): Promise<void> {
    const parsed = parseInteractiveCommand(command);
    addEvent("user", command === "/apply-confirmed" ? "Confirmed patch application" : command);

    try {
      if (parsed.name === "/quit") {
        exit();
        return;
      }

      if (parsed.name === "/help") {
        addEvent("agent", COMMANDS.map((item) => `${item.usage}\n  ${item.description}`).join("\n\n"));
        return;
      }

      if (parsed.name === "/inspect") {
        setPhase("inspect");
        const result = await workflows.inspect();
        if (result.agentMap) setAgentMap(result.agentMap);
        addEvent("agent", result.message);
        setPhase("idle");
        return;
      }

      if (parsed.name === "/scan") {
        setPhase("scan");
        const result = await workflows.scan();
        if (result.agentMap) setAgentMap(result.agentMap);
        if (result.findings) setFindings(result.findings);
        if (result.run?.patches) setPatches(result.run.patches);
        addEvent("agent", result.message);
        setPhase("idle");
        return;
      }

      if (parsed.name === "/harden") {
        setPhase("harden");
        const result = await workflows.harden();
        if (result.patches) setPatches(result.patches);
        if (result.run?.findings) setFindings(result.run.findings);
        addEvent("agent", result.message);
        setPhase("idle");
        return;
      }

      if (parsed.name === "/redteam") {
        setPhase("redteam");
        const result = await workflows.redteam(parseRedTeamOptions(parsed.args));
        if (result.agentMap) setAgentMap(result.agentMap);
        if (result.findings) setFindings(result.findings);
        if (result.redTeam) setRedTeam(result.redTeam);
        addEvent("agent", result.message);
        setPhase("idle");
        return;
      }

      if (parsed.name === "/apply") {
        const patch = patches.find((item) => item.status === "proposed");
        if (!patch) {
          addEvent("agent", "No proposed patch is waiting. Run /harden first.");
          return;
        }
        setPhase("confirm");
        setPendingApply(true);
        addEvent("system", `Confirm source edit for ${patch.targetPath}? Press y to apply, n to cancel.\n\n${truncate(patch.diff, 1600)}`);
        return;
      }

      if (parsed.name === "/apply-confirmed") {
        setPhase("apply");
        const result = await workflows.applyFirstPatch();
        if (result.patches) setPatches(result.patches);
        if (result.run?.findings) setFindings(result.run.findings);
        addEvent("agent", result.message);
        setPhase("idle");
        return;
      }

      if (parsed.name === "/replay") {
        setPhase("replay");
        const result = await workflows.replay();
        if (result.replay) setReplay(result.replay);
        if (result.run?.redTeam) setRedTeam(result.run.redTeam);
        addEvent("agent", result.message);
        setPhase("idle");
        return;
      }

      if (parsed.name === "/report") {
        setPhase("report");
        const result = await workflows.report();
        addEvent("agent", result.message);
        setPhase("idle");
        return;
      }

      if (parsed.name === "/update") {
        setPhase("update");
        const latestStatus = await checkForUpdate();
        setUpdateStatus(latestStatus);
        if (latestStatus.state === "available") {
          addEvent("system", `Installing ${latestStatus.packageName} ${latestStatus.latestVersion} with ${latestStatus.installCommand}`);
          const result = await installLatestUpdate();
          setUpdateStatus({
            state: "installed",
            packageName: latestStatus.packageName,
            currentVersion: latestStatus.currentVersion,
            latestVersion: latestStatus.latestVersion,
            checkedAt: new Date().toISOString()
          });
          addEvent(
            "agent",
            [
              `Updated ${latestStatus.packageName} from ${latestStatus.currentVersion} to ${latestStatus.latestVersion}.`,
              "Restart agentblast to run the new version.",
              summarizeInstallOutput(result.stdout, result.stderr)
            ]
              .filter(Boolean)
              .join("\n")
          );
          setPhase("idle");
          return;
        }
        if (latestStatus.state === "current") {
          addEvent("agent", `Agent Blast is up to date at ${latestStatus.currentVersion}.`);
          setPhase("idle");
          return;
        }
        if (latestStatus.state === "disabled") {
          addEvent("agent", `Update checks are disabled. Current version: ${latestStatus.currentVersion}.`);
          setPhase("idle");
          return;
        }
        if (latestStatus.state === "unavailable") {
          addEvent("error", `Could not check for updates: ${latestStatus.error}`);
          setPhase("idle");
          return;
        }
        addEvent("error", "No installable update state returned.");
        setPhase("idle");
        return;
      }

      if (parsed.name.startsWith("/") && !COMMANDS.some((item) => item.name === parsed.name)) {
        addEvent("error", `Unknown command: ${parsed.name}. Type /help for available commands.`);
        setPhase("idle");
        return;
      }

      setPhase("chat");
      const result = await workflows.ask(command);
      for (const toolEvent of result.toolEvents ?? []) {
        addEvent("tool", toolEvent);
      }
      if (result.agentMap) setAgentMap(result.agentMap);
      addEvent("agent", result.message);
      setPhase("idle");
    } catch (error) {
      setPhase("error");
      addEvent("error", error instanceof Error ? error.message : String(error));
    }
  }

  function addEvent(role: TranscriptEvent["role"], text: string): void {
    setEvents((current) => [...current.slice(-20), event(role, text)]);
  }

  const suggestions = suggestionsForInput(input);

  return (
    <AgentBlastView
      cwd={cwd}
      model={model}
      oauthStatus={oauthStatus}
      phase={phase}
      input={input}
      suggestions={suggestions}
      events={events}
      agentMap={agentMap}
      findings={findings}
      patches={patches}
      redTeam={redTeam}
      replay={replay}
      updateStatus={updateStatus}
      width={stdout.columns ?? 100}
      pendingApply={pendingApply}
    />
  );

  function suggestionsForInput(value: string): CommandDefinition[] {
    if (!value.startsWith("/")) return [];
    const commandName = value.split(/\s+/)[0] ?? value;
    return COMMANDS.filter((command) => command.name.startsWith(commandName) || commandName === "/").slice(0, 6);
  }
}

export function AgentBlastView(props: {
  cwd: string;
  model: string;
  oauthStatus: string;
  phase: Phase;
  input: string;
  suggestions: typeof COMMANDS;
  events: TranscriptEvent[];
  agentMap?: AgentMap;
  findings: Finding[];
  patches: PatchProposal[];
  redTeam?: RedTeamRun;
  replay?: ReplayResult;
  updateStatus?: UpdateStatus;
  width: number;
  pendingApply?: boolean;
}) {
  const compact = props.width < 92;
  const transcript = props.events.slice(compact ? -8 : -12);
  const accent = props.phase === "error" ? "red" : props.phase === "idle" ? "cyan" : "yellow";
  const nextAction = nextActionFor(props);

  return (
    <Box flexDirection="column" minHeight={24}>
      <Box flexDirection="column" borderStyle="single" borderColor={accent} paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color="cyan">Agent Blast</Text>
          <Text color={accent}>{phaseLabel(props.phase)}</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color="gray">{shortenPath(props.cwd, compact ? 46 : 70)}</Text>
          <Text color={props.oauthStatus.includes("OAuth") ? "green" : "yellow"}>{props.oauthStatus} | {props.model}</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color={updateColor(props.updateStatus)}>{props.updateStatus ? updateStatusLabel(props.updateStatus) : `v${PACKAGE_VERSION}`}</Text>
          <Text color="gray">{props.updateStatus?.state === "available" ? "Run /update" : " "}</Text>
        </Box>
      </Box>

      <Box flexDirection={compact ? "column" : "row"} flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} minHeight={16} borderStyle="single" borderColor="gray" paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold>Transcript</Text>
            <Text color="gray">{nextAction}</Text>
          </Box>
          {transcript.map((item) => (
            <Box key={item.id} flexDirection="column" marginTop={1}>
              <Text>
                <Text color={roleColor(item.role)}>{roleLabel(item.role).padEnd(12)}</Text>
                <Text>{truncate(item.text, compact ? 700 : 1100)}</Text>
              </Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column" width={compact ? undefined : 42} borderStyle="single" borderColor="gray" paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold>Inspector</Text>
            <Text color="gray">{surfaceTotal(props.agentMap)} surfaces</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">EP {props.agentMap?.entrypoints.length ?? 0} | Model {props.agentMap?.modelCalls.length ?? 0} | Prompts {props.agentMap?.prompts.length ?? 0}</Text>
            <Text color="gray">Tools {props.agentMap?.tools.length ?? 0} | Retrieval {props.agentMap?.retrieval.length ?? 0}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Workflow</Text>
            <Text>{workflowLine(props)}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Findings</Text>
            {props.findings.slice(0, compact ? 4 : 6).map((finding) => (
              <Text key={finding.id} color={severityColor(finding.severity)}>
                {finding.id} {finding.severity} {truncate(finding.title, compact ? 48 : 34)}
              </Text>
            ))}
            {props.findings.length === 0 && <Text color="gray">None yet</Text>}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Red Team</Text>
            {props.redTeam ? (
              <>
                <Text color={props.redTeam.failed > 0 ? "red" : "green"}>
                  {props.redTeam.failed} failed | {props.redTeam.passed} passed | {props.redTeam.needsReview} review
                </Text>
                <Text color="gray">{props.redTeam.mode} | {props.redTeam.attempts ?? 0} attempts | ASR {formatRate(props.redTeam.attackSuccessRate)}</Text>
              </>
            ) : (
              <Text color="gray">Not run</Text>
            )}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Patches</Text>
            {props.patches.slice(0, 4).map((patch) => (
              <Text key={patch.id} color={patch.status === "applied" ? "green" : patch.status === "failed" ? "red" : "yellow"}>
                {patch.id} {patch.status} {truncate(patch.targetPath, compact ? 48 : 22)}
              </Text>
            ))}
            {props.patches.length === 0 && <Text color="gray">None yet</Text>}
          </Box>
          {props.replay && (
            <Box marginTop={1} flexDirection="column">
              <Text bold>Replay</Text>
              <Text color="green">Fixed: {props.replay.fixedFindingIds.length}</Text>
              <Text color="yellow">Remaining: {props.replay.remainingFindingIds.length}</Text>
            </Box>
          )}
        </Box>
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor={props.pendingApply ? "yellow" : "cyan"} paddingX={1}>
        {props.suggestions.length > 0 && <CommandPalette suggestions={props.suggestions} compact={compact} />}
        <Text>
          <Text color={props.pendingApply ? "yellow" : "cyan"}>{props.pendingApply ? "confirm > " : "agentblast > "}</Text>
          <Text>{props.pendingApply ? "press y to apply, n to cancel" : props.input || "Type /, /redteam standard, or ask about the codebase"}</Text>
        </Text>
        <Text color="gray">Enter run | Tab complete | Up/Down history | Esc clear | Ctrl-C quit</Text>
      </Box>
    </Box>
  );
}

function CommandPalette(props: { suggestions: CommandDefinition[]; compact: boolean }) {
  return (
    <Box flexDirection="column">
      <Text color="gray">Commands</Text>
      {props.suggestions.slice(0, props.compact ? 4 : 6).map((command, index) => (
        <Text key={command.name}>
          <Text color={index === 0 ? "cyan" : "gray"}>{index === 0 ? "> " : "  "}{props.compact ? command.name : command.usage}</Text>
          <Text color="gray">  {command.description}</Text>
        </Text>
      ))}
    </Box>
  );
}

function event(role: TranscriptEvent["role"], text: string): TranscriptEvent {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    text,
    timestamp: new Date().toISOString()
  };
}

function roleLabel(role: TranscriptEvent["role"]): string {
  if (role === "user") return "You";
  if (role === "agent") return "Agent Blast";
  if (role === "tool") return "Tool";
  if (role === "error") return "Error";
  return "System";
}

function phaseLabel(phase: Phase): string {
  if (phase === "idle") return "ready";
  if (phase === "confirm") return "confirmation required";
  if (phase === "update") return "updating cli";
  if (phase === "error") return "attention needed";
  return `running ${phase}`;
}

function updateColor(status: UpdateStatus | undefined): string {
  if (!status) return "gray";
  if (status.state === "available") return "yellow";
  if (status.state === "installed" || status.state === "current") return "green";
  if (status.state === "unavailable") return "gray";
  return "gray";
}

function roleColor(role: TranscriptEvent["role"]): string {
  if (role === "user") return "cyan";
  if (role === "agent") return "white";
  if (role === "tool") return "yellow";
  if (role === "error") return "red";
  return "gray";
}

function severityColor(severity: string): string {
  if (severity === "critical" || severity === "high") return "red";
  if (severity === "medium") return "yellow";
  if (severity === "low") return "blue";
  return "gray";
}

function formatRate(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0%";
  return `${Math.round(value * 1000) / 10}%`;
}

function surfaceTotal(agentMap: AgentMap | undefined): number {
  if (!agentMap) return 0;
  return agentMap.entrypoints.length + agentMap.modelCalls.length + agentMap.prompts.length + agentMap.tools.length + agentMap.retrieval.length;
}

function workflowLine(props: { agentMap?: AgentMap; findings: Finding[]; redTeam?: RedTeamRun; patches: PatchProposal[]; replay?: ReplayResult }): string {
  const steps = [
    ["inspect", Boolean(props.agentMap)],
    ["scan", props.findings.length > 0],
    ["redteam", Boolean(props.redTeam)],
    ["harden", props.patches.length > 0],
    ["replay", Boolean(props.replay)]
  ] as const;
  return steps.map(([name, done]) => `${done ? "[x]" : "[ ]"} ${name}`).join("  ");
}

function nextActionFor(props: {
  agentMap?: AgentMap;
  findings: Finding[];
  redTeam?: RedTeamRun;
  patches: PatchProposal[];
  replay?: ReplayResult;
  pendingApply?: boolean;
}): string {
  if (props.pendingApply) return "Next: confirm patch";
  if (!props.agentMap) return "Next: /inspect";
  if (props.findings.length === 0 && !props.redTeam) return "Next: /scan or /redteam standard";
  if (!props.redTeam) return "Next: /redteam standard";
  if (props.patches.some((patch) => patch.status === "proposed")) return "Next: /apply";
  if (props.findings.some((finding) => finding.status === "open")) return "Next: /harden";
  if (!props.replay) return "Next: /replay";
  return "Next: /report";
}

export function parseInteractiveCommand(input: string): { name: string; args: string[] } {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  return {
    name: tokens[0] ?? "",
    args: tokens.slice(1)
  };
}

export function parseRedTeamOptions(args: string[]): {
  mode?: RedTeamMode;
  strategy?: RedTeamStrategy;
  maxCases?: number;
  maxAttemptsPerCase?: number;
  maxDepth?: number;
  executor?: RedTeamExecutorMode;
  includeTerminalChecks?: boolean;
  objective?: string;
} {
  const result: ReturnType<typeof parseRedTeamOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "quick" || arg === "standard" || arg === "deep") {
      result.mode = arg;
      continue;
    }
    if (arg === "--mode" && isMode(next)) {
      result.mode = next;
      index += 1;
      continue;
    }
    if (arg === "--strategy" && isStrategy(next)) {
      result.strategy = next;
      index += 1;
      continue;
    }
    if (arg === "--executor" && isExecutor(next)) {
      result.executor = next;
      index += 1;
      continue;
    }
    if (arg === "--max-cases" && next) {
      result.maxCases = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--max-attempts-per-case" && next) {
      result.maxAttemptsPerCase = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--max-depth" && next) {
      result.maxDepth = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--include-terminal-checks") {
      result.includeTerminalChecks = true;
      continue;
    }
    if (arg === "--objective" && next) {
      result.objective = next;
      index += 1;
    }
  }
  return result;
}

function isMode(value: string | undefined): value is RedTeamMode {
  return value === "quick" || value === "standard" || value === "deep";
}

function isStrategy(value: string | undefined): value is RedTeamStrategy {
  return value === "deterministic" || value === "fuzz" || value === "tree_search" || value === "hybrid";
}

function isExecutor(value: string | undefined): value is RedTeamExecutorMode {
  return value === "auto" || value === "static" || value === "emulated" || value === "local_command" || value === "local_http";
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, length - 1)}…`;
}

function shortenPath(value: string, max: number): string {
  if (value.length <= max) return value;
  return `…${value.slice(value.length - max + 1)}`;
}

function summarizeInstallOutput(stdout: string, stderr: string): string {
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
  if (!output) return "";
  return truncate(output, 900);
}
