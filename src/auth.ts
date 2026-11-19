/**
 * auth.ts — Tipos del JWT y comprobaciones de sesión/rol para las rutas REST.
 */
import type { FastifyRequest } from "fastify";
import type { Role } from "./contract";
import { AppError } from "./errors";

export interface JwtPayload {
  sub: string;
  name: string;
  role: Role;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

/** preHandler: exige un access token válido. Si no, responde 401 (la web renueva y reintenta). */
export async function authenticate(request: FastifyRequest): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    throw new AppError(401, "unauthorized", "Sesión inválida o expirada.");
  }
}

/** preHandler: exige además uno de los roles indicados (403 si no). */
export function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest): Promise<void> => {
    await authenticate(request);
    if (!roles.includes(request.user.role)) {
      throw new AppError(403, "forbidden", "No tienes permiso para esta acción.");
    }
  };
}
