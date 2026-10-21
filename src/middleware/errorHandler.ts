import type { ErrorRequestHandler, RequestHandler } from "express";
import multer from "multer";
import { ZodError } from "zod";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: "not_found",
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "validation_error",
        message: "Invalid request",
        details: err.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      },
    });
    return;
  }
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    res
      .status(status)
      .json({ error: { code: err.code.toLowerCase(), message: err.message } });
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json({
      error: { code: "payload_too_large", message: "Request body too large" },
    });
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({
      error: {
        code: "invalid_json",
        message: "Request body is not valid JSON",
      },
    });
    return;
  }

  // Upstream model errors (Azure OpenAI)
  const status = typeof err?.status === "number" ? err.status : 500;
  logger.error("Unhandled error", {
    method: req.method,
    path: req.path,
    status,
    error: err?.message,
  });
  if (status === 429) {
    res.status(429).json({
      error: {
        code: "rate_limited",
        message: "The AI service is busy. Please retry shortly.",
      },
    });
    return;
  }
  res.status(500).json({
    error: { code: "internal_error", message: "Something went wrong" },
  });
};
