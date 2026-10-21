import type { Request, Response } from "express";
import { jobRepository } from "../repository/jobRepository.js";
import { IdParam } from "../schemas/common.js";
import { notFound } from "../utils/errors.js";

export const jobController = {
  async get(req: Request, res: Response) {
    const { id } = IdParam.parse(req.params);
    const job = await jobRepository.findById(id);
    if (!job) throw notFound("Job not found");
    res.json({ job });
  },
};
