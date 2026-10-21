import { combineApiRouters } from "./apiRouter.js";
import { healthRoutes } from "./health.routes.js";
import { jobRoutes } from "./jobs.routes.js";
import { queryRoutes } from "./query.routes.js";
import { sourceRoutes } from "./sources.routes.js";

export const router = combineApiRouters([
  healthRoutes,
  sourceRoutes,
  jobRoutes,
  queryRoutes,
]);
