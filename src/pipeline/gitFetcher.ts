import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AppError } from "../utils/errors.js";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

/** Username paired with the token in HTTP Basic auth, per host. */
function tokenUser(host: string): string {
  if (host === "github.com") return "x-access-token";
  if (host === "gitlab.com") return "oauth2";
  if (host === "bitbucket.org") return "x-token-auth";
  return "pat"; // Azure DevOps accepts any username with a PAT
}

/**
 * Environment for git child processes.
 * The token is passed as an HTTP header via GIT_CONFIG_* env vars -- never in the URL or
 * command-line arguments -- so it can't leak into .git/config, process lists or error messages.
 */
const PASSTHROUGH_ENV = [
  // Corporate proxies and custom CA bundles must still work for git
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "ALL_PROXY", "all_proxy",
  "GIT_SSL_CAINFO", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "GIT_CONFIG_PARAMETERS", // admin-provided git config (e.g. http.proxy) set via environment
];

function gitEnv(host: string, token?: string): NodeJS.ProcessEnv {
  const passthrough = Object.fromEntries(
    PASSTHROUGH_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
  );
  const env: NodeJS.ProcessEnv = {
    ...passthrough,
    PATH: process.env.PATH,
    HOME: os.tmpdir(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    ...(process.platform === "win32"
      ? { SystemRoot: process.env.SystemRoot, USERPROFILE: os.tmpdir(), TEMP: os.tmpdir(), TMP: os.tmpdir() }
      : {}),
  };
  if (token) {
    const basic = Buffer.from(`${tokenUser(host)}:${token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  return env;
}

function toAppError(err: unknown): AppError {
  const msg = String((err as { stderr?: string }).stderr ?? (err as Error).message ?? "");
  if (/ENOENT/.test(msg) && /spawn git/.test(msg)) {
    return new AppError(500, "git_missing", "git is not installed on the server");
  }
  if (/Authentication failed|could not read Username|terminal prompts disabled|403|401|not found|does not exist|Repository not found/i.test(msg)) {
    return new AppError(
      422,
      "repo_access_denied",
      "Repository not found or not accessible. For private repos, send a token with read access (GitHub: fine-grained PAT with Contents: Read).",
    );
  }
  if (/Could not resolve host|unable to access|timed out|Connection refused/i.test(msg)) {
    return new AppError(502, "git_unreachable", "Could not reach the Git host. Check the URL and network access.");
  }
  // Do not echo raw stderr: it can contain URLs/headers.
  return new AppError(502, "git_error", "Git command failed while accessing the repository");
}

/**
 * Get the latest commit SHA of a branch without cloning (`git ls-remote`).
 * If `branch` is omitted, resolves the repository's default branch.
 */
export async function getRemoteHead(
  cloneUrl: string,
  host: string,
  branch: string | undefined,
  token?: string,
): Promise<{ branch: string; sha: string }> {
  try {
    if (branch) {
      const { stdout } = await run("git", ["ls-remote", "--", cloneUrl, `refs/heads/${branch}`], {
        env: gitEnv(host, token),
        timeout: 60_000,
      });
      const sha = stdout.trim().split(/\s+/)[0];
      if (!sha) throw new AppError(422, "branch_not_found", `Branch '${branch}' not found in repository`);
      return { branch, sha };
    }
    const { stdout } = await run("git", ["ls-remote", "--symref", "--", cloneUrl, "HEAD"], {
      env: gitEnv(host, token),
      timeout: 60_000,
    });
    const ref = /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(stdout);
    const sha = /^([0-9a-f]{40,64})\s+HEAD$/m.exec(stdout);
    if (!ref || !sha) throw new AppError(422, "empty_repo", "Could not determine the default branch (empty repository?)");
    return { branch: ref[1]!, sha: sha[1]! };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw toAppError(err);
  }
}

/** Shallow-clone a single branch (latest commit only) into a new temp directory. */
export async function cloneShallow(
  cloneUrl: string,
  host: string,
  branch: string,
  token?: string,
): Promise<{ dir: string; sha: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-embed-git-"));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true });
  try {
    await run(
      "git",
      ["clone", "--depth", "1", "--single-branch", "--no-tags", "--branch", branch, "--", cloneUrl, dir],
      { env: gitEnv(host, token), timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    );
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"], { env: gitEnv(host) });
    return { dir, sha: stdout.trim(), cleanup };
  } catch (err) {
    await cleanup().catch(() => undefined);
    throw err instanceof AppError ? err : toAppError(err);
  }
}
