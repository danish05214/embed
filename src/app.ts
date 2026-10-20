import cors from "cors";
import express from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { config } from "./config.js";
import { generateOpenApiSpec } from "./docs/openapi.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { noStore } from "./middleware/security.js";
import { router } from "./routes/index.js";

/** URL prefix for every API route. Used for both the real routes and the Swagger spec. */
export const API_PREFIX = "/api";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  if (config.apiDocsEnabled) {
    const spec = generateOpenApiSpec(API_PREFIX);
    const docsHelmet = helmet({
      contentSecurityPolicy: {
        directives: { upgradeInsecureRequests: null },
      },
    });
    app.get(`${API_PREFIX}/docs.json`, docsHelmet, (_req, res) => res.json(spec));
    app.use(
      `${API_PREFIX}/docs`,
      docsHelmet,
      swaggerUi.serve,
      swaggerUi.setup(spec, { customSiteTitle: "CS Embed API" }),
    );
  }

  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins as unknown as string[],
      methods: ["GET", "POST", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(API_PREFIX, noStore, router);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
