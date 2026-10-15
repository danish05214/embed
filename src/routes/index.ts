import { Router } from "express";
import { jobController } from "../controllers/jobController.js";
import { queryController } from "../controllers/queryController.js";
import { sourceController } from "../controllers/sourceController.js";
import { rateLimit } from "../middleware/security.js";
import { uploadFiles } from "../middleware/upload.js";
import { pool } from "../db.js";

// Express 5 forwards rejected promises from async handlers to the error handler automatically.
export const router = Router();

const ingestLimit = rateLimit({ windowMs: 60_000, max: 10 });
const queryLimit = rateLimit({ windowMs: 60_000, max: 30 });

router.get("/health", async (_req, res) => {
  await pool.query("select 1");
  res.json({ status: "ok" });
});

// Sources (repos and uploads)
router.post("/sources/git", ingestLimit, sourceController.addGit);
router.post("/sources/upload", ingestLimit, uploadFiles, sourceController.upload);
router.post("/sources/:id/sync", ingestLimit, sourceController.sync);
router.get("/sources", sourceController.list);
router.get("/sources/:id", sourceController.get);
router.delete("/sources/:id", sourceController.remove);

// Jobs
router.get("/jobs/:id", jobController.get);

// Questions
router.post("/query", queryLimit, queryController.ask);
