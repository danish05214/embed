import fs from "node:fs/promises";
import { config } from "../config.js";
import { manifestHash, indexFiles } from "../pipeline/indexer.js";
import { cloneShallow, getRemoteHead } from "../pipeline/gitFetcher.js";
import {
  filterFile,
  sanitizeRelativePath,
  walkDirectory,
} from "../pipeline/fileWalker.js";
import { jobQueue } from "../pipeline/jobQueue.js";
import { jobRepository } from "../repository/jobRepository.js";
import { sourceRepository } from "../repository/sourceRepository.js";
import type { InputFile, Job, Source } from "../types.js";
import { badRequest, notFound } from "../utils/errors.js";
import {
  gitSourceKey,
  isValidBranchName,
  parseRepoUrl,
} from "../utils/gitUrl.js";
import { hashFile } from "../utils/hash.js";

export interface IngestResult {
  status: "queued" | "already_running" | "up_to_date";
  source: Source;
  job: Job | null;
}

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

  const { source } = await sourceRepository.findOrCreate({
    sourceKey,
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
      await indexFiles({ sourceId: source.id, files, mode: "full", report });
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
}): Promise<IngestResult & { skipped: { path: string; reason: string }[] }> {
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
  const ok = await sourceRepository.delete(id);
  if (!ok) throw notFound("Source not found");
}
