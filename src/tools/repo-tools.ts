import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { toPosixPath } from "../core/paths.js";

const DEFAULT_IGNORES = [
  ".git/**",
  ".agentblast/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  ".next/**",
  "coverage/**",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.pdf",
  "*.zip",
  "*.sqlite",
  "*.db"
];

const MAX_READ_BYTES = 180_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;

export type RepoFile = {
  path: string;
  absolutePath: string;
};

export type SearchMatch = {
  path: string;
  line: number;
  text: string;
};

export type SafeReadFileOptions = {
  offset?: number;
  limit?: number;
  maxBytes?: number;
};

export type SafeReadFileResult = {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
};

export type SearchCodeOptions = {
  limit?: number;
  literal?: boolean;
  timeoutMs?: number;
};

export async function discoverFiles(cwd: string): Promise<RepoFile[]> {
  const gitignore = await loadGitignore(cwd);
  const files = await fg(["**/*"], {
    cwd,
    onlyFiles: true,
    dot: true,
    ignore: DEFAULT_IGNORES,
    unique: true
  });

  return files
    .map(toPosixPath)
    .filter((file) => !gitignore.ignores(file))
    .sort()
    .map((file) => ({
      path: file,
      absolutePath: path.join(cwd, file)
    }));
}

export async function safeReadFile(cwd: string, relativePath: string, options: SafeReadFileOptions = {}): Promise<string> {
  return (await safeReadFileDetailed(cwd, relativePath, options)).content;
}

export async function safeReadFileDetailed(cwd: string, relativePath: string, options: SafeReadFileOptions = {}): Promise<SafeReadFileResult> {
  const absolutePath = await resolveWorkspaceFile(cwd, relativePath);
  const maxBytes = clampNumber(options.maxBytes, MAX_READ_BYTES, 1, MAX_READ_BYTES);
  const buffer = await readFile(absolutePath);
  if (looksBinary(buffer)) {
    throw new Error(`Refusing to read binary file: ${relativePath}`);
  }

  const truncatedByBytes = buffer.byteLength > maxBytes;
  const raw = (truncatedByBytes ? buffer.subarray(0, maxBytes) : buffer).toString("utf8");
  const lines = raw.split("\n");
  const totalLines = lines.length;
  const startLine = clampNumber(options.offset, 1, 1, Math.max(totalLines, 1));
  const requestedLimit = clampNumber(options.limit, totalLines, 1, 2_000);
  const selected = lines.slice(startLine - 1, startLine - 1 + requestedLimit);
  const endLine = selected.length > 0 ? startLine + selected.length - 1 : startLine;
  const truncatedByLines = endLine < totalLines;
  const suffix = truncatedByBytes ? `\n\n[Agent Blast truncated this file at ${maxBytes} bytes]` : "";

  return {
    path: toPosixPath(relativePath),
    content: `${selected.join("\n")}${suffix}`,
    startLine,
    endLine,
    totalLines,
    truncated: truncatedByBytes || truncatedByLines
  };
}

export async function searchCode(cwd: string, query: string, options: SearchCodeOptions = {}): Promise<SearchMatch[]> {
  const limit = clampNumber(options.limit, 100, 1, 500);
  try {
    const result = await runRg(cwd, query, options);
    if (result.exitCode !== 0 && result.stdout.length === 0) return [];
    return parseRgJsonMatches(result.stdout).slice(0, limit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ENOENT|not found/i.test(message)) throw error;
    return searchCodeFallback(cwd, query, { ...options, literal: true }).then((matches) => matches.slice(0, limit));
  }
}

export async function readRelevantFiles(cwd: string, files: RepoFile[], maxFiles = 80): Promise<Map<string, string>> {
  const relevant = files
    .filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs|md|mdx|json)$/i.test(file.path))
    .slice(0, maxFiles);

  const result = new Map<string, string>();
  for (const file of relevant) {
    try {
      result.set(file.path, await safeReadFile(cwd, file.path));
    } catch {
      // Ignore unreadable files during broad inspection; explicit reads can surface the error.
    }
  }
  return result;
}

export function detectLanguage(files: RepoFile[]): "typescript" | "javascript" | "mixed" | "unknown" {
  const ts = files.some((file) => /\.(ts|tsx)$/i.test(file.path));
  const js = files.some((file) => /\.(js|jsx|mjs|cjs)$/i.test(file.path));
  if (ts && js) return "mixed";
  if (ts) return "typescript";
  if (js) return "javascript";
  return "unknown";
}

export function detectFramework(files: RepoFile[]): "nextjs" | "node" | "unknown" {
  if (files.some((file) => file.path === "next.config.js" || file.path === "next.config.mjs" || file.path === "next.config.ts")) {
    return "nextjs";
  }
  if (files.some((file) => file.path === "package.json")) return "node";
  return "unknown";
}

export async function resolveWorkspaceFile(cwd: string, relativePath: string): Promise<string> {
  assertSafeRelativePath(relativePath);
  const root = await realpath(cwd);
  const absolutePath = path.resolve(root, relativePath);
  const stats = await lstat(absolutePath);
  if (!stats.isFile() && !stats.isSymbolicLink()) {
    throw new Error(`Refusing to read non-file path: ${relativePath}`);
  }
  const resolved = await realpath(absolutePath);
  if (!isPathInside(root, resolved)) {
    throw new Error(`Refusing to read outside target workspace: ${relativePath}`);
  }
  return resolved;
}

export async function resolveWorkspaceDirectory(cwd: string, relativePath = "."): Promise<string> {
  assertSafeRelativePath(relativePath);
  const root = await realpath(cwd);
  const absolutePath = path.resolve(root, relativePath);
  const resolved = await realpath(absolutePath);
  const stats = await lstat(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`Command workdir is not a directory: ${relativePath}`);
  }
  if (!isPathInside(root, resolved)) {
    throw new Error(`Refusing to use workdir outside target workspace: ${relativePath}`);
  }
  return resolved;
}

function assertSafeRelativePath(relativePath: string): void {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0") || path.normalize(relativePath).split(path.sep).includes("..")) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }
}

async function loadGitignore(cwd: string) {
  const ig = ignore().add(DEFAULT_IGNORES);
  try {
    ig.add(await readFile(path.join(cwd, ".gitignore"), "utf8"));
  } catch {
    // Missing .gitignore is fine.
  }
  return ig;
}

function runRg(cwd: string, query: string, options: SearchCodeOptions): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      "--json",
      "--hidden",
      "--color",
      "never",
      "--glob",
      "!.git/**",
      "--glob",
      "!.agentblast/**",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!dist/**",
      "--glob",
      "!build/**",
      "--glob",
      "!.next/**"
    ];
    if (options.literal) args.push("-F");
    args.push(query);
    const child = spawn("rg", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, clampNumber(options.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS, 1_000, 60_000));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function parseRgJsonMatches(stdout: string): SearchMatch[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      let event: unknown;
      try {
        event = JSON.parse(line) as unknown;
      } catch {
        return [];
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) return [];
      const record = event as Record<string, unknown>;
      if (record.type !== "match" || !record.data || typeof record.data !== "object") return [];
      const data = record.data as Record<string, unknown>;
      const pathText = readTextValue(data.path);
      const lineText = readTextValue(data.lines)?.replace(/\n$/, "");
      const lineNumber = typeof data.line_number === "number" ? data.line_number : NaN;
      if (!pathText || !lineText || Number.isNaN(lineNumber)) return [];
      return [{ path: toPosixPath(pathText), line: lineNumber, text: lineText.trim() }];
    });
}

async function searchCodeFallback(cwd: string, query: string, options: SearchCodeOptions): Promise<SearchMatch[]> {
  const files = await discoverFiles(cwd);
  const contents = await readRelevantFiles(cwd, files, 500);
  const matches: SearchMatch[] = [];
  const matcher = options.literal ? undefined : createRegex(query);
  for (const [filePath, content] of contents) {
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const found = matcher ? matcher.test(line) : line.includes(query);
      if (found) {
        matches.push({ path: filePath, line: index + 1, text: line.trim() });
      }
      if (matches.length >= clampNumber(options.limit, 100, 1, 500)) return matches;
    }
  }
  return matches;
}

function createRegex(query: string): RegExp | undefined {
  try {
    return new RegExp(query, "i");
  } catch {
    return undefined;
  }
}

function readTextValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const text = (value as Record<string, unknown>).text;
  return typeof text === "string" ? text : undefined;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000));
  return sample.includes(0);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
