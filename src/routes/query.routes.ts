import { queryController } from "../controllers/queryController.js";
import { rateLimit } from "../middleware/security.js";
import { QueryBody, QueryResult } from "../schemas/query.js";
import { createApiRouter } from "./apiRouter.js";

export const queryRoutes = createApiRouter({ prefix: "/query", tag: "Query" });

const queryLimit = rateLimit({ windowMs: 60_000, max: 30 });

// POST /api/query
queryRoutes.post(
  "/",
  {
    summary: "Ask a question over indexed sources",
    body: QueryBody,
    responses: {
      200: { description: "Answer with cited sources", schema: QueryResult },
    },
  },
  queryLimit,
  queryController.ask,
);
