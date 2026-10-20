import type { Request, Response } from "express";
import { QueryBody } from "../schemas/query.js";
import { answerQuestion } from "../services/queryService.js";

export const queryController = {
  async ask(req: Request, res: Response) {
    const body = QueryBody.parse(req.body);
    res.json(await answerQuestion(body));
  },
};
