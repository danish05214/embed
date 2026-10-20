import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  type RouteConfig,
} from "@asteasolutions/zod-to-openapi";
import type { RequestHandler } from "express";
import { z } from "zod";
import { getRateLimitInfo } from "../middleware/security.js";
import { ErrorResponse } from "../schemas/common.js";

const registry = new OpenAPIRegistry();

export type Method = "get" | "post" | "put" | "patch" | "delete";

type ResponseDoc = string | { description: string; schema: z.ZodType };

export interface RouteDoc {
  tag?: string;
  summary: string;
  description?: string;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  bodyType?: "json" | "multipart";
  bodyRequired?: boolean;
  responses: Record<number, ResponseDoc>;
}

const toOpenApiPath = (path: string) => path.replace(/:(\w+)/g, "{$1}");

function buildResponses(doc: RouteDoc, handlers: RequestHandler[]) {
  const responses: RouteConfig["responses"] = {};
  const errorContent = { "application/json": { schema: ErrorResponse } };

  for (const [status, r] of Object.entries(doc.responses)) {
    if (typeof r === "string") {
      responses[status] =
        Number(status) >= 400
          ? { description: r, content: errorContent }
          : { description: r };
    } else {
      responses[status] = {
        description: r.description,
        content: { "application/json": { schema: r.schema } },
      };
    }
  }

  // Standard responses added automatically when not documented explicitly.
  if ((doc.params || doc.query || doc.body) && !responses["400"]) {
    responses["400"] = {
      description: "Validation error",
      content: errorContent,
    };
  }
  const limit = handlers.map(getRateLimitInfo).find(Boolean);
  if (limit && !responses["429"]) {
    const perMin = Math.round((limit.max * 60_000) / limit.windowMs);
    responses["429"] = {
      description: `Rate limited (${perMin} requests/min per IP)`,
      content: errorContent,
    };
  }
  if (!responses["500"]) {
    responses["500"] = {
      description: "Unexpected server error",
      content: errorContent,
    };
  }
  return responses;
}

/** Record one route in the spec. Called by ApiRouter (src/routes/apiRouter.ts) for every route. */
export function registerRoute(
  method: Method,
  path: string,
  tag: string,
  doc: RouteDoc,
  handlers: RequestHandler[],
) {
  const openApiPath = toOpenApiPath(path);

  // Path params not described explicitly are still listed (as strings).
  let params = doc.params;
  const names = [...path.matchAll(/:(\w+)/g)].map((m) => m[1]);
  if (!params && names.length) {
    params = z.object(Object.fromEntries(names.map((n) => [n, z.string()])));
  }

  const mediaType =
    doc.bodyType === "multipart" ? "multipart/form-data" : "application/json";

  registry.registerPath({
    method,
    path: openApiPath,
    tags: [doc.tag ?? tag],
    summary: doc.summary,
    description: doc.description,
    request: {
      params,
      query: doc.query,
      body: doc.body
        ? {
            required: doc.bodyRequired ?? true,
            content: { [mediaType]: { schema: doc.body } },
          }
        : undefined,
    },
    responses: buildResponses(doc, handlers),
  });
}

/** Build the OpenAPI document from every route registered through an ApiRouter. */
export function generateOpenApiSpec(serverUrl: string) {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "CS Embed API",
      version: "0.1.0",
      description:
        "Index Git repositories and uploaded documents into pgvector, and answer questions with cited sources.",
    },
    servers: [{ url: serverUrl }],
  });
}
