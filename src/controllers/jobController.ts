import type { Request, Response } from "express";
import { z } from "zod";
import { jobRepository } from "../repository/jobRepository.js";
import { notFound } from "../utils/errors.js";

const IdParam = z.object({ id: z.string().uuid("id must be a UUID") });

export const jobController = {
  /** GET /api/jobs/:id */
  async get(req: Request, res: Response) {
    const { id } = IdParam.parse(req.params);
    const job = await jobRepository.findById(id);
    if (!job) throw notFound("Job not found");
    res.json({ job });
  },
};
