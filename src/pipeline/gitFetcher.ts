import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AppError } from "../utils/errors.js";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

function tokenUser(host: string): string {
  if (host === "github.com") return "x-access-token";
  if (host === "gitlab.com") return "oauth2";
  if (host === "bitbucket.org") return "x-token-auth";
  return "pat";
}

const PASSTHROUGH_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
  "GIT_SSL_CAINFO",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_CONFIG_PARAMETERS",
];

function gitEnv(host: string, token?: string): NodeJS.ProcessEnv {
  const passthrough = Object.fromEntries(
    PASSTHROUGH_ENV.filter((k) => process.env[k] !== undefined).map((k) => [
      k,
      process.env[k],
    ]),
  );
  const env: NodeJS.ProcessEnv = {
    ...passthrough,
    PATH: process.env.PATH,
    HOME: os.tmpdir(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    ...(process.platform === "win32"
      ? {
          SystemRoot: process.env.SystemRoot,
          USERPROFILE: os.tmpdir(),
          TEMP: os.tmpdir(),
          TMP: os.tmpdir(),
        }
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
  const msg = String(
    (err as { stderr?: string }).stderr ?? (err as Error).message ?? "",
  );
  if (/ENOENT/.test(msg) && /spawn git/.test(msg)) {
    return new AppError(
      500,
      "git_missing",
      "git is not installed on the server",
    );
  }
  if (
    /Authentication failed|could not read Username|terminal prompts disabled|403|401|not found|does not exist|Repository not found/i.test(
      msg,
    )
  ) {
    return new AppError(
      422,
      "repo_access_denied",
      "Repository not found or not accessible. For private repos, send a token with read access (GitHub: fine-grained PAT with Contents: Read).",
    );
  }
  if (
    /Could not resolve host|unable to access|timed out|Connection refused/i.test(
      msg,
    )
  ) {
    return new AppError(
      502,
      "git_unreachable",
      "Could not reach the Git host. Check the URL and network access.",
    );
  }
  return new AppError(
    502,
    "git_error",
    "Git command failed while accessing the repository",
  );
}

export async function getRemoteHead(
  cloneUrl: string,
  host: string,
  branch: string | undefined,
  token?: string,
): Promise<{ branch: string; sha: string }> {
  try {
    if (branch) {
      const { stdout } = await run(
        "git",
        ["ls-remote", "--", cloneUrl, `refs/heads/${branch}`],
        {
          env: gitEnv(host, token),
          timeout: 60_000,
        },
      );
      const sha = stdout.trim().split(/\s+/)[0];
      if (!sha)
        throw new AppError(
          422,
          "branch_not_found",
          `Branch '${branch}' not found in repository`,
        );
      return { branch, sha };
    }
    const { stdout } = await run(
      "git",
      ["ls-remote", "--symref", "--", cloneUrl, "HEAD"],
      {
        env: gitEnv(host, token),
        timeout: 60_000,
      },
    );
    const ref = /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(stdout);
    const sha = /^([0-9a-f]{40,64})\s+HEAD$/m.exec(stdout);
    if (!ref || !sha)
      throw new AppError(
        422,
        "empty_repo",
        "Could not determine the default branch (empty repository?)",
      );
    return { branch: ref[1]!, sha: sha[1]! };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw toAppError(err);
  }
}

/** All branches on the remote with their latest commit (`git ls-remote --heads`, no clone). */
export async function listRemoteBranches(
  cloneUrl: string,
  host: string,
  token?: string,
): Promise<{ name: string; sha: string }[]> {
  try {
    const { stdout } = await run(
      "git",
      ["ls-remote", "--heads", "--", cloneUrl],
      {
        env: gitEnv(host, token),
        timeout: 60_000,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    const branches: { name: string; sha: string }[] = [];
    for (const line of stdout.split("\n")) {
      const m = /^([0-9a-f]{40,64})\s+refs\/heads\/(\S+)$/.exec(line.trim());
      if (m) branches.push({ sha: m[1]!, name: m[2]! });
    }
    return branches.sort((a, b) => a.name.localeCompare(b.name));
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
      [
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--no-tags",
        "--branch",
        branch,
        "--",
        cloneUrl,
        dir,
      ],
      {
        env: gitEnv(host, token),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"], {
      env: gitEnv(host),
    });
    return { dir, sha: stdout.trim(), cleanup };
  } catch (err) {
    await cleanup().catch(() => undefined);
    throw err instanceof AppError ? err : toAppError(err);
  }
}
