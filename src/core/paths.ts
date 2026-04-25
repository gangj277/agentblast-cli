import path from "node:path";

export const AGENTBLAST_DIR = ".agentblast";

export function resolveTargetCwd(cwd: string): string {
  return path.resolve(cwd);
}

export function workspacePath(cwd: string): string {
  return path.join(resolveTargetCwd(cwd), AGENTBLAST_DIR);
}

export function runPath(cwd: string, runId: string): string {
  return path.join(workspacePath(cwd), "runs", runId);
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
