import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { noStore } from "./middleware/security.js";
import { router } from "./routes/index.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins as unknown as string[],
      methods: ["GET", "POST", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", noStore, router);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
