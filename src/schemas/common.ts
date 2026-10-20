import { z } from "zod";

/** `:id` path param used by /sources/:id, /jobs/:id, ... */
export const IdParam = z.object({
  id: z.string().uuid("id must be a UUID"),
});

/** Shape of every error response (see middleware/errorHandler.ts). */
export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string().meta({ example: "validation_error" }),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: "Error" });

export const HealthResponse = z
  .object({ status: z.literal("ok") })
  .meta({ id: "Health" });
