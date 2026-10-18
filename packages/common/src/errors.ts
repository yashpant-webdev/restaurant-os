/**
 * Typed application errors. Business code throws these; the HTTP layer maps
 * them to status codes. Anything that is not an AppError is treated as a bug:
 * it is logged in full and the client gets a generic 500 with no internals.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_FAILED', 400, message, details);
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super('UNAUTHORIZED', 401, message);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = 'Not allowed') {
    super('FORBIDDEN', 403, message);
  }
}
export class NotFoundError extends AppError {
  constructor(what: string) {
    super('NOT_FOUND', 404, `${what} not found`);
  }
}
export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, 409, message, details);
  }
}
export class UnprocessableError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, 422, message, details);
  }
}
/** A dependency (another service, the payment gateway) failed or timed out. Safe to retry. */
export class UpstreamError extends AppError {
  constructor(message: string, readonly retryable = true, details?: unknown) {
    super('UPSTREAM_UNAVAILABLE', 503, message, details);
  }
}
