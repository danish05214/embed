import { combineApiRouters } from "./apiRouter.js";
import { healthRoutes } from "./health.routes.js";
import { jobRoutes } from "./jobs.routes.js";
import { queryRoutes } from "./query.routes.js";
import { sourceRoutes } from "./sources.routes.js";

// One file per feature. To add a feature: create `<feature>.routes.ts` with
// createApiRouter({ prefix, tag }) and add it to this list. It shows up in Swagger automatically.
// (Express 5 forwards rejected promises from async handlers to the error handler.)
export const router = combineApiRouters([
  healthRoutes,
  sourceRoutes,
  jobRoutes,
  queryRoutes,
]);
