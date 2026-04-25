import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../core/package-info.js";

const execFileAsync = promisify(execFile);
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export type UpdateStatus =
  | {
      state: "checking";
      packageName: string;
      currentVersion: string;
    }
  | {
      state: "current";
      packageName: string;
      currentVersion: string;
      latestVersion: string;
      checkedAt: string;
    }
  | {
      state: "available";
      packageName: string;
      currentVersion: string;
      latestVersion: string;
      installCommand: string;
      checkedAt: string;
    }
  | {
      state: "installed";
      packageName: string;
      currentVersion: string;
      latestVersion: string;
      checkedAt: string;
    }
  | {
      state: "disabled";
      packageName: string;
      currentVersion: string;
    }
  | {
      state: "unavailable";
      packageName: string;
      currentVersion: string;
      error: string;
      checkedAt: string;
    };

export type CheckForUpdateOptions = {
  packageName?: string;
  currentVersion?: string;
  registryUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  disabled?: boolean;
};

export type InstallUpdateOptions = {
  packageName?: string;
  registryUrl?: string;
  npmCommand?: string;
};

export type InstallUpdateResult = {
  command: string;
  stdout: string;
  stderr: string;
};

export async function checkForUpdate(options: CheckForUpdateOptions = {}): Promise<UpdateStatus> {
  const packageName = options.packageName ?? PACKAGE_NAME;
  const currentVersion = options.currentVersion ?? PACKAGE_VERSION;

  if (options.disabled ?? process.env.AGENTBLAST_DISABLE_UPDATE_CHECK === "1") {
    return { state: "disabled", packageName, currentVersion };
  }

  try {
    const latestVersion = await fetchLatestVersion({
      packageName,
      registryUrl: options.registryUrl,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl
    });
    const checkedAt = new Date().toISOString();
    if (compareSemver(currentVersion, latestVersion) < 0) {
      return {
        state: "available",
        packageName,
        currentVersion,
        latestVersion,
        installCommand: buildInstallCommand(packageName),
        checkedAt
      };
    }
    return {
      state: "current",
      packageName,
      currentVersion,
      latestVersion,
      checkedAt
    };
  } catch (error) {
    return {
      state: "unavailable",
      packageName,
      currentVersion,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString()
    };
  }
}

export async function installLatestUpdate(options: InstallUpdateOptions = {}): Promise<InstallUpdateResult> {
  const packageName = options.packageName ?? PACKAGE_NAME;
  const registryUrl = options.registryUrl ?? DEFAULT_REGISTRY;
  const npmCommand = options.npmCommand ?? defaultNpmCommand();
  const args = ["install", "-g", `${packageName}@latest`, `--registry=${registryUrl}`];
  const result = await execFileAsync(npmCommand, args, {
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  });
  return {
    command: `${npmCommand} ${args.join(" ")}`,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export function buildInstallCommand(packageName = PACKAGE_NAME): string {
  return `npm install -g ${packageName}@latest`;
}

export function updateStatusLabel(status: UpdateStatus): string {
  if (status.state === "checking") return `v${status.currentVersion} | checking updates`;
  if (status.state === "available") return `v${status.currentVersion} | update ${status.latestVersion} available`;
  if (status.state === "installed") return `v${status.latestVersion} installed | restart`;
  if (status.state === "current") return `v${status.currentVersion} current`;
  if (status.state === "disabled") return `v${status.currentVersion} | updates off`;
  return `v${status.currentVersion} | update check unavailable`;
}

export function compareSemver(left: string, right: string): -1 | 0 | 1 {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
}

async function fetchLatestVersion(options: {
  packageName: string;
  registryUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const registryUrl = options.registryUrl ?? DEFAULT_REGISTRY;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2500);
  try {
    const response = await fetchImpl(`${registryUrl.replace(/\/$/, "")}/${encodeURIComponent(options.packageName)}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`npm registry returned ${response.status}`);
    }
    const metadata: unknown = await response.json();
    const latest = readLatestDistTag(metadata);
    if (!latest) {
      throw new Error("npm registry response did not include dist-tags.latest");
    }
    return latest;
  } finally {
    clearTimeout(timeout);
  }
}

function readLatestDistTag(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const tags = (metadata as { "dist-tags"?: unknown })["dist-tags"];
  if (!tags || typeof tags !== "object") return undefined;
  const latest = (tags as { latest?: unknown }).latest;
  return typeof latest === "string" ? latest : undefined;
}

function parseSemver(value: string): { major: number; minor: number; patch: number; prerelease: string } {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) {
    return { major: 0, minor: 0, patch: 0, prerelease: value };
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? ""
  };
}

function defaultNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
