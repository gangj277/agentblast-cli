import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_BIN = "codex";

export type CodexLoginStatus = {
  loggedIn: boolean;
  provider: "chatgpt" | "api-key" | "unknown" | "none";
  raw: string;
};

export type CodexExecResult = {
  message: string;
  model: string;
  stdout: string;
  stderr: string;
};

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type CodexJsonEvent = {
  type: string;
  [key: string]: unknown;
};

export type CodexOAuthClientOptions = {
  bin?: string;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
};

export type CodexExecOptions = {
  cwd?: string;
  model?: string;
  sandbox?: CodexSandboxMode;
  json?: boolean;
  timeoutMs?: number;
  onEvent?: (event: CodexJsonEvent) => void;
};

type RunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export class CodexCommandError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, result: RunResult) {
    super(message);
    this.name = "CodexCommandError";
    this.exitCode = result.exitCode;
    this.signal = result.signal;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

export class CodexOAuthClient {
  readonly bin: string;
  readonly model: string;
  readonly cwd: string;
  readonly timeoutMs: number;

  constructor(options: CodexOAuthClientOptions = {}) {
    this.bin = options.bin ?? process.env.AGENTBLAST_CODEX_BIN ?? DEFAULT_CODEX_BIN;
    this.model = options.model ?? process.env.AGENTBLAST_CODEX_MODEL ?? DEFAULT_CODEX_MODEL;
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async getLoginStatus(): Promise<CodexLoginStatus> {
    const result = await runCommand(this.bin, ["login", "status"], {
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      env: sanitizedCodexEnv()
    });

    const raw = `${result.stdout}${result.stderr}`.trim();
    return parseCodexLoginStatus(raw);
  }

  async assertChatGptOAuth(): Promise<CodexLoginStatus> {
    const status = await this.getLoginStatus();
    if (!status.loggedIn || status.provider !== "chatgpt") {
      throw new Error(
        `Codex OAuth is not ready. Expected "Logged in using ChatGPT"; got: ${status.raw || "<empty>"}`
      );
    }
    return status;
  }

  async exec(prompt: string, options: CodexExecOptions = {}): Promise<CodexExecResult> {
    await this.assertChatGptOAuth();

    const model = options.model ?? this.model;
    const cwd = options.cwd ?? this.cwd;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const tempDir = await mkdtemp(path.join(tmpdir(), "agentblast-codex-"));
    const outputFile = path.join(tempDir, "last-message.txt");

    try {
      const args = buildCodexExecArgs({
        model,
        outputFile,
        prompt,
        sandbox: options.sandbox,
        json: options.json
      });

      const result = await runCommand(this.bin, args, {
        cwd,
        timeoutMs,
        env: sanitizedCodexEnv(),
        onStdoutLine: options.onEvent
          ? (line) => {
              const event = parseCodexJsonEvent(line);
              if (event) options.onEvent?.(event);
            }
          : undefined
      });

      if (result.exitCode !== 0) {
        throw new CodexCommandError(`Codex exec failed with exit code ${result.exitCode}`, result);
      }

      const message = (await readFile(outputFile, "utf8")).trim();
      return {
        message,
        model,
        stdout: result.stdout,
        stderr: result.stderr
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export function parseCodexLoginStatus(raw: string): CodexLoginStatus {
  const normalized = raw.toLowerCase();
  if (normalized.includes("logged in using chatgpt")) {
    return { loggedIn: true, provider: "chatgpt", raw };
  }
  if (normalized.includes("logged in using api key")) {
    return { loggedIn: true, provider: "api-key", raw };
  }
  if (normalized.includes("not logged in")) {
    return { loggedIn: false, provider: "none", raw };
  }
  return {
    loggedIn: normalized.includes("logged in"),
    provider: normalized.includes("logged in") ? "unknown" : "none",
    raw
  };
}

export function buildCodexExecArgs(input: {
  model: string;
  outputFile: string;
  prompt: string;
  sandbox?: CodexSandboxMode;
  json?: boolean;
}): string[] {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--model",
    input.model,
    "--sandbox",
    input.sandbox ?? "read-only",
    "--output-last-message",
    input.outputFile
  ];
  if (input.json) args.push("--json");
  args.push(input.prompt);
  return args;
}

export function sanitizedCodexEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // AgentBlast must use the user's Codex ChatGPT/OAuth session, not API-key billing.
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_ORG_ID;
  delete env.OPENAI_PROJECT;
  delete env.OPENROUTER_API_KEY;
  delete env.ANTHROPIC_API_KEY;

  return env;
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    onStdoutLine?: (line: string) => void;
  }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let bufferedStdoutLine = "";

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (options.onStdoutLine) {
        bufferedStdoutLine += chunk;
        const lines = bufferedStdoutLine.split("\n");
        bufferedStdoutLine = lines.pop() ?? "";
        for (const line of lines) {
          options.onStdoutLine(line);
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (options.onStdoutLine && bufferedStdoutLine.trim()) {
        options.onStdoutLine(bufferedStdoutLine);
      }
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

export function parseCodexJsonEvent(line: string): CodexJsonEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return undefined;
    return parsed as CodexJsonEvent;
  } catch {
    return undefined;
  }
}
