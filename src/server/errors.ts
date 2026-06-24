/**
 * Hierarquia única de erros de domínio (porta `app/errors.py`).
 *
 * O domínio levanta um `AppError` tipado; o wrapper de rota (`http/route.ts`)
 * serializa `{ code, detail }` com o status certo.
 *
 * Regra degrade-vs-propagate:
 *   - No fluxo de CHAT, erros degradam para handoff 200 (o Orchestrator captura).
 *   - Nos demais endpoints, AppError PROPAGA com o status tipado.
 */

export class AppError extends Error {
  readonly statusCode: number = 500;
  readonly code: string = "internal_error";
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.detail = detail;
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = "not_found";
}

export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = "conflict";
}

export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = "validation_error";
}

export class UnauthorizedError extends AppError {
  readonly statusCode = 401;
  readonly code = "unauthorized";
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = "forbidden";
}

export class EmbeddingUnavailableError extends AppError {
  readonly statusCode = 503;
  readonly code = "embedding_unavailable";
}
