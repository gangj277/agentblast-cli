import { spawn } from "node:child_process";
import { resolveWorkspaceDirectory } from "./repo-tools.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 80_000;
const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|passwd|credential|private|auth|session|cookie|database_url|db_url|dsn)/i;

export type TerminalPolicy = {
  allowed: boolean;
  risk: "low" | "medium" | "blocked";
  reason: string;
};

export type RunTerminalCommandInput = {
  command: string;
  workdir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type TerminalCommandResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  policy: TerminalPolicy;
};

export async function runTerminalCommand(cwd: string, input: RunTerminalCommandInput): Promise<TerminalCommandResult> {
  const command = normalizeCommand(input.command);
  const policy = classifyTerminalCommand(command);
  const workdir = await resolveWorkspaceDirectory(cwd, input.workdir ?? ".");
  if (!policy.allowed) {
    return {
      command,
      cwd: workdir,
      exitCode: null,
      stdout: "",
      stderr: policy.reason,
      durationMs: 0,
      timedOut: false,
      truncated: false,
      policy
    };
  }

  return executeShellCommand({
    command,
    cwd: workdir,
    timeoutMs: clampNumber(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 600_000),
    maxOutputBytes: clampNumber(input.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1_000, 250_000),
    policy
  });
}

export function classifyTerminalCommand(command: string): TerminalPolicy {
  if (!command.trim()) {
    return blocked("Empty commands are not useful.");
  }
  if (command.length > 2_000) {
    return blocked("Command is too long for the Agent Blast terminal tool.");
  }
  if (command.includes("\0")) {
    return blocked("Command contains a null byte.");
  }

  const normalized = command.toLowerCase();
  const blockedRules: Array<[RegExp, string]> = [
    [/\b(sudo|su)\b/, "Privilege escalation is not allowed."],
    [/\b(rm|rmdir|unlink|shred|mkfs|dd)\b/, "Destructive filesystem commands are blocked."],
    [/\b(chmod|chown|chgrp)\b/, "Permission-changing commands are blocked."],
    [/\b(kill|killall|pkill)\b/, "Process-killing commands are blocked."],
    [/\b(git)\s+(reset|clean|checkout|restore|switch|push|commit|merge|rebase|cherry-pick|tag)\b/, "Git state-changing commands are blocked."],
    [/\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade|publish|login|logout)\b/, "Dependency mutation or package publishing is blocked."],
    [/\b(curl|wget|nc|netcat|ssh|scp|rsync|ftp|telnet)\b/, "Network and remote-shell commands are blocked in the agent terminal tool."],
    [/\b(sed|perl)\s+[^;&|]*\s-i\b/, "In-place editing commands are blocked."],
    [/(^|[^0-9])>>?[^&]/, "Shell output redirection is blocked; use AgentBlast patch workflows for writes."],
    [/\btee\b/, "Writing through tee is blocked."],
    [/(^|\/)\.env(\.|$|\/)/, "Reading environment secret files is blocked."],
    [/(^|\/)\.ssh($|\/)/, "Reading SSH material is blocked."],
    [/(^|\/)\.npmrc($|\/)/, "Reading package-manager credentials is blocked."],
    [/\.codex\/auth\.json/, "Reading Codex auth tokens is blocked."]
  ];

  for (const [pattern, reason] of blockedRules) {
    if (pattern.test(normalized)) return blocked(reason);
  }

  if (/\b(npm|pnpm|yarn|bun)\s+(test|run|exec|dlx)\b/.test(normalized)) {
    return { allowed: true, risk: "medium", reason: "Allowed test/script execution inside the opened workspace." };
  }
  if (/\b(node|tsx|ts-node|python|python3|ruby|perl|bash|sh)\b/.test(normalized)) {
    return { allowed: true, risk: "medium", reason: "Allowed local script/interpreter execution inside the opened workspace." };
  }
  if (/\b(vitest|jest|pytest|tsc|eslint|biome|ruff|mypy|go test|cargo test)\b/.test(normalized)) {
    return { allowed: true, risk: "medium", reason: "Allowed local verification command." };
  }

  return { allowed: true, risk: "low", reason: "Allowed local workspace command." };
}

function executeShellCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  policy: TerminalPolicy;
}): Promise<TerminalCommandResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn("/bin/bash", ["-lc", input.command], {
      cwd: input.cwd,
      env: buildCommandEnv(input.cwd),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2_000).unref();
    }, input.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const next = appendOutput(stdout, chunk, input.maxOutputBytes);
      stdout = next.value;
      truncated ||= next.truncated;
    });
    child.stderr.on("data", (chunk: string) => {
      const next = appendOutput(stderr, chunk, input.maxOutputBytes);
      stderr = next.value;
      truncated ||= next.truncated;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        command: input.command,
        cwd: input.cwd,
        exitCode,
        stdout: redactKnownSecrets(stdout),
        stderr: redactKnownSecrets(stderr),
        durationMs: Date.now() - start,
        timedOut,
        truncated,
        policy: input.policy
      });
    });
  });
}

function normalizeCommand(command: string): string {
  return command.trim();
}

function blocked(reason: string): TerminalPolicy {
  return { allowed: false, risk: "blocked", reason };
}

function buildCommandEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_KEY_RE.test(key)) continue;
    env[key] = value;
  }
  env.AGENTBLAST_TERMINAL = "1";
  env.HOME = cwd;
  return env;
}

function appendOutput(current: string, chunk: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(current, "utf8") >= maxBytes) return { value: current, truncated: true };
  const allowed = maxBytes - Buffer.byteLength(current, "utf8");
  if (Buffer.byteLength(chunk, "utf8") <= allowed) {
    return { value: current + chunk, truncated: false };
  }
  const clipped = Buffer.from(chunk).subarray(0, allowed).toString("utf8");
  return { value: `${current}${clipped}\n[Agent Blast truncated terminal output at ${maxBytes} bytes]\n`, truncated: true };
}

function redactKnownSecrets(value: string): string {
  let redacted = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (!secret || secret.length < 8 || !SECRET_KEY_RE.test(key)) continue;
    redacted = redacted.split(secret).join(`[redacted:${key}]`);
  }
  return redacted;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
