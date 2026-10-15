import { createApp } from "./app.js";
import { config } from "./config.js";
import { checkDatabase, pool } from "./db.js";
import { jobRepository } from "./repository/jobRepository.js";
import { sourceRepository } from "./repository/sourceRepository.js";
import { logger } from "./utils/logger.js";

async function main() {
  await checkDatabase();

  const interrupted = await jobRepository.failInterrupted();
  const stuck = await sourceRepository.resetStuck();
  if (interrupted || stuck)
    logger.warn("Recovered after restart", {
      interruptedJobs: interrupted,
      stuckSources: stuck,
    });

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(
      `CS Embed API listening on http://localhost:${config.port}/api`,
    );
  });

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("Failed to start", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
