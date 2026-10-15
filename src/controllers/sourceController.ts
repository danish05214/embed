import type { Request, Response } from "express";
import { z } from "zod";
import {
  addGitSource,
  addUpload,
  deleteSource,
  getSource,
  listSources,
  resyncGitSource,
  type IngestResult,
} from "../services/sourceService.js";
import { badRequest } from "../utils/errors.js";

const GitSourceBody = z.object({
  repoUrl: z.string().min(1).max(500),
  branch: z.string().min(1).max(200).optional(),
  token: z.string().min(1).max(500).optional(),
  name: z.string().min(1).max(200).optional(),
  force: z.boolean().optional(),
});

const SyncBody = z.object({
  token: z.string().min(1).max(500).optional(),
  force: z.boolean().optional(),
});

const UploadFields = z.object({
  name: z.string().min(1).max(200).optional(),
  mode: z.enum(["merge", "replace"]).default("merge"),
  paths: z.string().optional(),
});

const IdParam = z.object({ id: z.string().uuid("id must be a UUID") });

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

  /** GET /api/sources */
  async list(_req: Request, res: Response) {
    res.json({ sources: await listSources() });
  },

  /** GET /api/sources/:id */
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
