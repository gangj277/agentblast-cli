import React, { useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { AgentMap, Finding, PatchProposal, RedTeamRun, ReplayResult, TranscriptEvent } from "../core/types.js";
import { AgentBlastWorkflows } from "../workflows/agentblast-workflows.js";
import { DEFAULT_CODEX_MODEL } from "../codex/codex-oauth-client.js";

type Phase = "idle" | "inspect" | "scan" | "redteam" | "harden" | "confirm" | "apply" | "replay" | "report" | "chat" | "error";

export type AgentBlastAppProps = {
  cwd: string;
  model?: string;
  workflows?: AgentBlastWorkflows;
};

const COMMANDS = [
  { name: "/inspect", description: "Map agent entrypoints, prompts, tools, retrieval" },
  { name: "/scan", description: "Create findings from the current agent map" },
  { name: "/redteam", description: "Run bounded local adversarial cases" },
  { name: "/harden", description: "Prepare bounded source patch proposals" },
  { name: "/apply", description: "Preview and confirm the next patch proposal" },
  { name: "/replay", description: "Rerun checks after source changes" },
  { name: "/report", description: "Write report markdown under .agentblast" },
  { name: "/help", description: "Show command reference" },
  { name: "/quit", description: "Exit Agent Blast" }
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
  const [events, setEvents] = useState<TranscriptEvent[]>(() => [
    event("system", "Agent Blast ready. Run /inspect or ask a question about this codebase.")
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
      if (submitted) void runCommand(submitted);
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
    addEvent("user", command === "/apply-confirmed" ? "Confirmed patch application" : command);

    try {
      if (command === "/quit") {
        exit();
        return;
      }

      if (command === "/help") {
        addEvent("agent", COMMANDS.map((item) => `${item.name} - ${item.description}`).join("\n"));
        return;
      }

      if (command === "/inspect") {
        setPhase("inspect");
        const result = await workflows.inspect();
        if (result.agentMap) setAgentMap(result.agentMap);
        addEvent("agent", result.message);
        setPhase("idle");
        return;
      }

      if (command === "/scan") {
        setPhase("scan");
        const result = await workflows.scan();
        if (result.agentMap) setAgentMap(result.agentMap);
        if (result.findings) setFindings(result.findings);
        if (result.run?.patches) setPatches(result.run.patches);
        addEvent("agent", result.message);
        setPhase("idle");
        return;
      }

      if (command === "/harden") {
        setPhase("harden");
        const result = await workflows.harden();
        if (result.patches) setPatches(result.patches);
        if (result.run?.findings) setFindings(result.run.findings);
        addEvent("agent", result.message);
        setPhase("idle");
        return;
      }

      if (command === "/redteam") {
        setPhase("redteam");
        const result = await workflows.redteam();
        if (result.agentMap) setAgentMap(result.agentMap);
        if (result.findings) setFindings(result.findings);
        if (result.redTeam) setRedTeam(result.redTeam);
        addEvent("agent", result.message);
        setPhase("idle");
        return;
      }

      if (command === "/apply") {
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

      if (command === "/apply-confirmed") {
        setPhase("apply");
        const result = await workflows.applyFirstPatch();
        if (result.patches) setPatches(result.patches);
        if (result.run?.findings) setFindings(result.run.findings);
        addEvent("agent", result.message);
        setPhase("idle");
        return;
      }

      if (command === "/replay") {
        setPhase("replay");
        const result = await workflows.replay();
        if (result.replay) setReplay(result.replay);
        if (result.run?.redTeam) setRedTeam(result.run.redTeam);
        addEvent("agent", result.message);
        setPhase("idle");
        return;
      }

      if (command === "/report") {
        setPhase("report");
        const result = await workflows.report();
        addEvent("agent", result.message);
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

  const suggestions = input.startsWith("/")
    ? COMMANDS.filter((command) => command.name.startsWith(input) || input === "/")
    : [];

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
      width={stdout.columns ?? 100}
      pendingApply={pendingApply}
    />
  );
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
  width: number;
  pendingApply?: boolean;
}) {
  const compact = props.width < 92;
  const transcript = props.events.slice(-12);
  const accent = props.phase === "error" ? "red" : props.phase === "idle" ? "cyan" : "yellow";

  return (
    <Box flexDirection="column" minHeight={24}>
      <Box justifyContent="space-between" borderStyle="single" borderColor={accent} paddingX={1}>
        <Text bold color="cyan">Agent Blast</Text>
        <Text color="gray">{shortenPath(props.cwd, compact ? 26 : 48)}</Text>
        <Text color="gray">{props.model}</Text>
        <Text color={props.oauthStatus.includes("OAuth") ? "green" : "yellow"}>{props.oauthStatus}</Text>
        <Text color={accent}>{props.phase}</Text>
      </Box>

      <Box flexDirection={compact ? "column" : "row"} flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} minHeight={16} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold>Transcript</Text>
          {transcript.map((item) => (
            <Box key={item.id} flexDirection="column" marginTop={1}>
              <Text color={roleColor(item.role)}>{roleLabel(item.role)}</Text>
              <Text>{truncate(item.text, compact ? 700 : 1100)}</Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column" width={compact ? undefined : 38} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold>Inspector</Text>
          <Text color="gray">Entrypoints: {props.agentMap?.entrypoints.length ?? 0}</Text>
          <Text color="gray">Model calls: {props.agentMap?.modelCalls.length ?? 0}</Text>
          <Text color="gray">Prompts: {props.agentMap?.prompts.length ?? 0}</Text>
          <Text color="gray">Tools: {props.agentMap?.tools.length ?? 0}</Text>
          <Text color="gray">Retrieval: {props.agentMap?.retrieval.length ?? 0}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Findings</Text>
            {props.findings.slice(0, 6).map((finding) => (
              <Text key={finding.id} color={severityColor(finding.severity)}>
                {finding.id} {finding.severity} {truncate(finding.title, 30)}
              </Text>
            ))}
            {props.findings.length === 0 && <Text color="gray">None yet</Text>}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Red Team</Text>
            {props.redTeam ? (
              <>
                <Text color={props.redTeam.failed > 0 ? "red" : "green"}>Failed: {props.redTeam.failed}</Text>
                <Text color="green">Passed: {props.redTeam.passed}</Text>
                <Text color="yellow">Review: {props.redTeam.needsReview}</Text>
                <Text color="gray">Attempts: {props.redTeam.attempts ?? 0}</Text>
                <Text color="gray">ASR: {formatRate(props.redTeam.attackSuccessRate)}</Text>
              </>
            ) : (
              <Text color="gray">Not run</Text>
            )}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Patches</Text>
            {props.patches.slice(0, 4).map((patch) => (
              <Text key={patch.id} color={patch.status === "applied" ? "green" : patch.status === "failed" ? "red" : "yellow"}>
                {patch.id} {patch.status}
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
        {props.suggestions.length > 0 && (
          <Text color="gray">
            {props.suggestions.map((command) => `${command.name} ${command.description}`).join("  ")}
          </Text>
        )}
        <Text>
          <Text color="cyan">{props.pendingApply ? "confirm" : "agentblast"} </Text>
          <Text>{props.pendingApply ? "press y/n" : props.input || "Type /inspect, /scan, or ask a codebase question"}</Text>
        </Text>
      </Box>
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

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, length - 1)}…`;
}

function shortenPath(value: string, max: number): string {
  if (value.length <= max) return value;
  return `…${value.slice(value.length - max + 1)}`;
}
