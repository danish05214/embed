import { badRequest } from "./errors.js";

export interface ParsedRepoUrl {
  /** Clean HTTPS clone URL without credentials, e.g. https://github.com/org/repo.git */
  cloneUrl: string;
  host: string;
  /** owner/repo (or org/project/_git/repo for Azure DevOps) in lower case */
  path: string;
}

/**
 * Validate and normalise a repo URL.
 * - HTTPS only, host must be on the allow-list (prevents the server being used to reach internal hosts).
 * - Credentials embedded in the URL are rejected: tokens must be sent in the `token` field.
 */
export function parseRepoUrl(raw: string, allowedHosts: readonly string[]): ParsedRepoUrl {
  let input = raw.trim();
  // git@github.com:org/repo.git -> https://github.com/org/repo.git
  const ssh = /^git@([^:]+):(.+)$/.exec(input);
  if (ssh) input = `https://${ssh[1]}/${ssh[2]}`;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw badRequest("repoUrl is not a valid URL");
  }
  if (url.protocol !== "https:") throw badRequest("Only https:// repository URLs are supported");
  if (url.username || url.password) {
    throw badRequest("Do not put credentials in repoUrl; send the token in the `token` field instead");
  }
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) {
    throw badRequest(`Git host '${host}' is not allowed. Allowed: ${allowedHosts.join(", ")}`);
  }

  const segments = url.pathname
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) throw badRequest("repoUrl must include owner and repository name");

  let path: string;
  if (host === "dev.azure.com") {
    // https://dev.azure.com/{org}/{project}/_git/{repo}
    const gitIdx = segments.indexOf("_git");
    if (gitIdx < 0 || !segments[gitIdx + 1]) throw badRequest("Azure DevOps URL must look like /{org}/{project}/_git/{repo}");
    path = segments.slice(0, gitIdx + 2).join("/");
  } else {
    // GitHub/GitLab/Bitbucket: ignore extra segments like /tree/main
    const treeIdx = segments.findIndex((s) => s === "tree" || s === "-" || s === "src" || s === "blob");
    path = (treeIdx > 1 ? segments.slice(0, treeIdx) : segments).join("/");
  }
  for (const seg of path.split("/")) {
    if (!/^[A-Za-z0-9._~%-]+$/.test(seg) || seg === "." || seg === "..") {
      throw badRequest("repoUrl contains invalid characters");
    }
  }

  const cloneUrl = host === "dev.azure.com" ? `https://${host}/${path}` : `https://${host}/${path}.git`;
  return { cloneUrl, host, path: path.toLowerCase() };
}

export function gitSourceKey(parsed: ParsedRepoUrl, branch: string): string {
  return `git:${parsed.host}/${parsed.path}@${branch}`;
}

export function isValidBranchName(branch: string): boolean {
  return (
    branch.length > 0 &&
    branch.length <= 200 &&
    /^[A-Za-z0-9._\/-]+$/.test(branch) &&
    !branch.startsWith("-") &&
    !branch.includes("..") &&
    !branch.endsWith(".lock")
  );
}
