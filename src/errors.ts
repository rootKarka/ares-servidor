/**
 * errors.ts — Formato de error del contrato: { "error": { "code": "...", "message": "..." } }
 */
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(error: FastifyError | AppError, request: FastifyRequest, reply: FastifyReply) {
  const statusCode = error.statusCode ?? 500;
  let code = "error";
  if (error instanceof AppError) code = error.code;
  else if ("validation" in error && error.validation) code = "bad_request";
  else if (statusCode === 429) code = "rate_limited";
  else if (statusCode === 401) code = "unauthorized";
  else if (statusCode >= 500) code = "internal_error";

  if (statusCode >= 500) request.log.error(error);
  const message =
    statusCode >= 500
      ? "Error interno del servidor."
      : statusCode === 429
        ? "Demasiados intentos. Espera un minuto e inténtalo de nuevo."
        : error.message;
  void reply.status(statusCode).send({ error: { code, message } });
}
