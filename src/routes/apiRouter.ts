import { Router, type RequestHandler } from "express";
import { registerRoute, type Method, type RouteDoc } from "../docs/openapi.js";

type AddRoute = (
  path: string,
  doc: RouteDoc,
  ...handlers: RequestHandler[]
) => void;

export interface ApiRouter {
  readonly prefix: string;
  readonly get: AddRoute;
  readonly post: AddRoute;
  readonly put: AddRoute;
  readonly patch: AddRoute;
  readonly delete: AddRoute;
}

const expressRouters = new WeakMap<ApiRouter, Router>();

export function createApiRouter(opts: {
  prefix: string;
  tag: string;
}): ApiRouter {
  const router = Router();

  const add =
    (method: Method): AddRoute =>
    (path, doc, ...handlers) => {
      // "/sources" + "/:id" -> "/sources/:id";  "/sources" + "/" -> "/sources"
      const fullPath = opts.prefix + (path === "/" ? "" : path);
      registerRoute(method, fullPath, opts.tag, doc, handlers);
      router[method](path, ...handlers);
    };

  const api: ApiRouter = {
    prefix: opts.prefix,
    get: add("get"),
    post: add("post"),
    put: add("put"),
    patch: add("patch"),
    delete: add("delete"),
  };
  expressRouters.set(api, router);
  return api;
}

export function combineApiRouters(routers: ApiRouter[]): Router {
  const root = Router();
  for (const api of routers) {
    root.use(api.prefix, expressRouters.get(api)!);
  }
  return root;
}
