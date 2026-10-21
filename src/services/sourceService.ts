import fs from "node:fs/promises";
import { config } from "../config.js";
import { manifestHash, indexFiles } from "../pipeline/indexer.js";
import {
  cloneShallow,
  getRemoteHead,
  listRemoteBranches,
} from "../pipeline/gitFetcher.js";
import {
  filterFile,
  sanitizeRelativePath,
  walkDirectory,
} from "../pipeline/fileWalker.js";
import { jobQueue } from "../pipeline/jobQueue.js";
import { documentRepository } from "../repository/documentRepository.js";
import { jobRepository } from "../repository/jobRepository.js";
import { sourceRepository } from "../repository/sourceRepository.js";
import type {
  IngestResult,
  MultiIngestResult,
  RemoteBranchList,
  UploadResult,
} from "../schemas/sources.js";
import type { InputFile, Job, Source } from "../types.js";
import { AppError, badRequest, notFound } from "../utils/errors.js";
import {
  gitScopeKey,
  gitSourceKey,
  isValidBranchName,
  parseRepoUrl,
} from "../utils/gitUrl.js";
import { hashFile } from "../utils/hash.js";
import { logger } from "../utils/logger.js";

export type {
  IngestResult,
  MultiIngestResult,
  RemoteBranchList,
  UploadResult,
} from "../schemas/sources.js";

/** Max branches returned by the branch list (very large repos can have thousands). */
const MAX_LISTED_BRANCHES = 1000;

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function addGitSource(input: {
  repoUrl: string;
  branch?: string;
  token?: string;
  name?: string;
  force?: boolean;
}): Promise<IngestResult> {
  const parsed = parseRepoUrl(input.repoUrl, config.git.allowedHosts);
  if (input.branch && !isValidBranchName(input.branch))
    throw badRequest("Invalid branch name");

  const head = await getRemoteHead(
    parsed.cloneUrl,
    parsed.host,
    input.branch,
    input.token,
  );
  const sourceKey = gitSourceKey(parsed, head.branch);

  const scopeKey = gitScopeKey(parsed);

  const { source } = await sourceRepository.findOrCreate({
    sourceKey,
    scopeKey,
    type: "git",
    name: input.name?.trim() || `${parsed.path}@${head.branch}`,
    repoUrl: parsed.cloneUrl,
    branch: head.branch,
  });

  const active = await jobRepository.activeForSource(source.id);
  if (active) return { status: "already_running", source, job: active };

  // Same commit already indexed -> nothing to do.
  if (
    !input.force &&
    source.status === "ready" &&
    source.lastCommitSha === head.sha
  ) {
    return {
      status: "up_to_date",
      source,
      job: await jobRepository.latestForSource(source.id),
    };
  }

  const job = await jobRepository.create(source.id, "git_sync");
  await sourceRepository.setStatus(source.id, "indexing");
  const token = input.token;

  jobQueue.enqueue(job.id, async (report) => {
    let cleanup: (() => Promise<void>) | undefined;
    try {
      await report({ message: "Cloning repository" });
      const clone = await cloneShallow(
        parsed.cloneUrl,
        parsed.host,
        head.branch,
        token,
      );
      cleanup = clone.cleanup;
      const { files } = await walkDirectory(clone.dir);
      await indexFiles({
        sourceId: source.id,
        scopeKey: source.scopeKey,
        files,
        mode: "full",
        report,
      });
      await sourceRepository.markIndexed(source.id, {
        lastCommitSha: clone.sha,
      });
    } catch (err) {
      await sourceRepository.setStatus(
        source.id,
        "failed",
        (err as Error).message.slice(0, 500),
      );
      throw err;
    } finally {
      await cleanup?.().catch(() => undefined);
    }
  });

  return {
    status: "queued",
    source: (await sourceRepository.findById(source.id))!,
    job,
  };
}

/** Branches on the remote, the default branch, and which of them are already indexed. */
export async function listGitBranches(input: {
  repoUrl: string;
  token?: string;
}): Promise<RemoteBranchList> {
  const parsed = parseRepoUrl(input.repoUrl, config.git.allowedHosts);
  const [head, remote, indexed] = await Promise.all([
    getRemoteHead(parsed.cloneUrl, parsed.host, undefined, input.token),
    listRemoteBranches(parsed.cloneUrl, parsed.host, input.token),
    sourceRepository.listByScope(gitScopeKey(parsed)),
  ]);
  const byBranch = new Map(indexed.map((s) => [s.branch, s]));
  return {
    repoUrl: parsed.cloneUrl,
    defaultBranch: head.branch,
    total: remote.length,
    truncated: remote.length > MAX_LISTED_BRANCHES,
    branches: remote.slice(0, MAX_LISTED_BRANCHES).map((b) => {
      const s = byBranch.get(b.name);
      return {
        name: b.name,
        sha: b.sha,
        isDefault: b.name === head.branch,
        sourceId: s?.id ?? null,
        status: s?.status ?? null,
        upToDate: s ? s.status === "ready" && s.lastCommitSha === b.sha : false,
      };
    }),
  };
}

/**
 * Index several chosen branches of one repo. Each branch becomes its own source; files that
 * are identical across branches are stored and embedded once and tagged with every branch.
 * Jobs run one after another, so later branches reuse what earlier ones indexed.
 */
export async function addGitBranches(input: {
  repoUrl: string;
  branches: string[];
  token?: string;
  force?: boolean;
}): Promise<MultiIngestResult> {
  const parsed = parseRepoUrl(input.repoUrl, config.git.allowedHosts);
  const branches = [...new Set(input.branches.map((b) => b.trim()))];
  const invalid = branches.filter((b) => !isValidBranchName(b));
  if (invalid.length)
    throw badRequest("Invalid branch name(s)", { branches: invalid });

  // Check every branch exists before queueing anything (all-or-nothing request).
  const remote = new Set(
    (await listRemoteBranches(parsed.cloneUrl, parsed.host, input.token)).map(
      (b) => b.name,
    ),
  );
  const missing = branches.filter((b) => !remote.has(b));
  if (missing.length)
    throw new AppError(
      422,
      "branch_not_found",
      `Branch(es) not found in repository: ${missing.join(", ")}`,
      { branches: missing },
    );

  const results: IngestResult[] = [];
  for (const branch of branches) {
    results.push(
      await addGitSource({
        repoUrl: input.repoUrl,
        branch,
        token: input.token,
        force: input.force,
      }),
    );
  }
  return { results };
}

export async function resyncGitSource(
  sourceId: string,
  token?: string,
  force = false,
): Promise<IngestResult> {
  const source = await sourceRepository.findById(sourceId);
  if (!source) throw notFound("Source not found");
  if (source.type !== "git" || !source.repoUrl)
    throw badRequest(
      "Only Git sources can be re-synced; re-upload documents instead",
    );
  return addGitSource({
    repoUrl: source.repoUrl,
    branch: source.branch ?? undefined,
    token,
    name: source.name,
    force,
  });
}

export interface UploadedFile {
  tempPath: string;
  relativePath: string;
  size: number;
}

export async function addUpload(input: {
  files: UploadedFile[];
  name?: string;
  mode: "merge" | "replace";
}): Promise<UploadResult> {
  const cleanupTemp = () =>
    Promise.all(
      input.files.map((f) =>
        fs.rm(f.tempPath, { force: true }).catch(() => undefined),
      ),
    );

  try {
    const accepted: InputFile[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const seen = new Set<string>();

    for (const f of input.files) {
      const rel = sanitizeRelativePath(f.relativePath);
      if (!rel) {
        skipped.push({ path: f.relativePath, reason: "invalid path" });
        continue;
      }
      if (seen.has(rel)) {
        skipped.push({ path: rel, reason: "duplicate path in upload" });
        continue;
      }
      const check = filterFile(rel, f.size);
      if (!check.ok) {
        skipped.push({ path: rel, reason: check.reason });
        continue;
      }
      seen.add(rel);
      accepted.push({ path: rel, absPath: f.tempPath, size: f.size });
    }

    if (accepted.length === 0) {
      throw badRequest("None of the uploaded files can be indexed", {
        skipped,
      });
    }

    const hashes = await Promise.all(
      accepted.map(async (f) => ({
        path: f.path,
        fileHash: await hashFile(f.absPath),
      })),
    );
    const manifest = manifestHash(hashes);
    const name = input.name?.trim();
    const sourceKey = name
      ? `upload:${slug(name)}`
      : `upload:${manifest.slice(0, 32)}`;

    const { source } = await sourceRepository.findOrCreate({
      sourceKey,
      scopeKey: sourceKey, // an upload collection only shares files with itself
      type: "upload",
      name:
        name ||
        (accepted.length === 1
          ? accepted[0]!.path
          : `Upload (${accepted.length} files)`),
    });

    const active = await jobRepository.activeForSource(source.id);
    if (active) {
      await cleanupTemp();
      return { status: "already_running", source, job: active, skipped };
    }

    if (source.status === "ready" && source.manifestHash === manifest) {
      await cleanupTemp();
      return {
        status: "up_to_date",
        source,
        job: await jobRepository.latestForSource(source.id),
        skipped,
      };
    }

    const job = await jobRepository.create(source.id, "upload");
    await sourceRepository.setStatus(source.id, "indexing");

    jobQueue.enqueue(job.id, async (report) => {
      try {
        await indexFiles({
          sourceId: source.id,
          scopeKey: source.scopeKey,
          files: accepted,
          mode: input.mode === "replace" ? "full" : "merge",
          report,
        });
        await sourceRepository.markIndexed(source.id, {
          manifestHash: manifest,
        });
      } catch (err) {
        await sourceRepository.setStatus(
          source.id,
          "failed",
          (err as Error).message.slice(0, 500),
        );
        throw err;
      } finally {
        await cleanupTemp();
      }
    });

    return {
      status: "queued",
      source: (await sourceRepository.findById(source.id))!,
      job,
      skipped,
    };
  } catch (err) {
    await cleanupTemp();
    throw err;
  }
}

export async function listSources(): Promise<Source[]> {
  return sourceRepository.list();
}

export async function getSource(
  id: string,
): Promise<{ source: Source; latestJob: Job | null }> {
  const source = await sourceRepository.findById(id);
  if (!source) throw notFound("Source not found");
  return { source, latestJob: await jobRepository.latestForSource(id) };
}

export async function deleteSource(id: string): Promise<void> {
  const active = await jobRepository.activeForSource(id);
  if (active)
    throw badRequest(
      "Source is being indexed; try again when the job finishes",
    );
  const source = await sourceRepository.findById(id);
  if (!source) throw notFound("Source not found");
  const ok = await sourceRepository.delete(id);
  if (!ok) throw notFound("Source not found");
  // Its branch tags are gone (cascade); delete file versions no other branch uses.
  try {
    await documentRepository.deleteOrphans(source.scopeKey);
  } catch (err) {
    logger.warn("Orphan clean-up skipped; it will run on the next indexing", {
      scopeKey: source.scopeKey,
      error: (err as Error).message,
    });
  }
}
