export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "bad_request", message, details);
export const notFound = (message: string) =>
  new AppError(404, "not_found", message);
export const conflict = (message: string) =>
  new AppError(409, "conflict", message);
export const unprocessable = (message: string) =>
  new AppError(422, "unprocessable", message);
