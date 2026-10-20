import { jobController } from "../controllers/jobController.js";
import { IdParam } from "../schemas/common.js";
import { JobResponse } from "../schemas/jobs.js";
import { createApiRouter } from "./apiRouter.js";

export const jobRoutes = createApiRouter({ prefix: "/jobs", tag: "Jobs" });

// GET /api/jobs/:id
jobRoutes.get(
  "/:id",
  {
    summary: "Indexing job progress (poll every 1–2 s)",
    params: IdParam,
    responses: {
      200: { description: "OK", schema: JobResponse },
      404: "Job not found",
    },
  },
  jobController.get,
);
