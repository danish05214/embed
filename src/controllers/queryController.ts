import type { Request, Response } from "express";
import { z } from "zod";
import { answerQuestion } from "../services/queryService.js";

const QueryBody = z.object({
  question: z.string().trim().min(1, "question is required").max(2000),
  sourceIds: z.array(z.string().uuid()).max(50).optional(),
  topK: z.number().int().min(1).max(30).optional(),
});

export const queryController = {
  async ask(req: Request, res: Response) {
    const body = QueryBody.parse(req.body);
    res.json(await answerQuestion(body));
  },
};
