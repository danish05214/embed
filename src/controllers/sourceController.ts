import type { Request, Response } from "express";
import { z } from "zod";
import {
  addGitBranches,
  addGitSource,
  addUpload,
  deleteSource,
  getSource,
  listGitBranches,
  listSources,
  resyncGitSource,
  type IngestResult,
} from "../services/sourceService.js";
import { IdParam } from "../schemas/common.js";
import {
  GitBranchesBody,
  GitSourceBody,
  RemoteBranchesBody,
  SyncBody,
  UploadFields,
} from "../schemas/sources.js";
import { badRequest } from "../utils/errors.js";

function sendIngest(
  res: Response,
  result: IngestResult & { skipped?: unknown },
) {
  res.status(result.status === "queued" ? 202 : 200).json(result);
}

export const sourceController = {
  /** POST /api/sources/git */
  async addGit(req: Request, res: Response) {
    const body = GitSourceBody.parse(req.body);
    sendIngest(res, await addGitSource(body));
  },

  /** POST /api/sources/git/remote-branches */
  async remoteBranches(req: Request, res: Response) {
    const body = RemoteBranchesBody.parse(req.body);
    res.json(await listGitBranches(body));
  },

  /** POST /api/sources/git/branches */
  async addGitBranches(req: Request, res: Response) {
    const body = GitBranchesBody.parse(req.body);
    const result = await addGitBranches(body);
    const anyQueued = result.results.some((r) => r.status === "queued");
    res.status(anyQueued ? 202 : 200).json(result);
  },

  /** POST /api/sources/:id/sync */
  async sync(req: Request, res: Response) {
    const { id } = IdParam.parse(req.params);
    const body = SyncBody.parse(req.body ?? {});
    sendIngest(res, await resyncGitSource(id, body.token, body.force));
  },

  /** POST /api/sources/upload (multipart/form-data, field `files`) */
  async upload(req: Request, res: Response) {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0)
      throw badRequest("No files uploaded. Use multipart field name 'files'.");
    const fields = UploadFields.parse(req.body ?? {});

    let paths: string[] | undefined;
    if (fields.paths) {
      try {
        paths = z
          .array(z.string().max(1000))
          .length(files.length)
          .parse(JSON.parse(fields.paths));
      } catch {
        throw badRequest(
          "`paths` must be a JSON array of strings with one entry per file",
        );
      }
    }

    const result = await addUpload({
      name: fields.name,
      mode: fields.mode,
      files: files.map((f, i) => ({
        tempPath: f.path,
        relativePath: paths?.[i] ?? f.originalname,
        size: f.size,
      })),
    });
    sendIngest(res, result);
  },

  async list(_req: Request, res: Response) {
    res.json({ sources: await listSources() });
  },

  async get(req: Request, res: Response) {
    const { id } = IdParam.parse(req.params);
    res.json(await getSource(id));
  },

  /** DELETE /api/sources/:id */
  async remove(req: Request, res: Response) {
    const { id } = IdParam.parse(req.params);
    await deleteSource(id);
    res.status(204).end();
  },
};
