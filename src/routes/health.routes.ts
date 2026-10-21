import { pool } from "../db.js";
import { HealthResponse } from "../schemas/common.js";
import { createApiRouter } from "./apiRouter.js";

export const healthRoutes = createApiRouter({
  prefix: "/health",
  tag: "Health",
});

healthRoutes.get(
  "/",
  {
    summary: "Server + database check",
    responses: { 200: { description: "OK", schema: HealthResponse } },
  },
  async (_req, res) => {
    await pool.query("select 1");
    res.json({ status: "ok" });
  },
);
