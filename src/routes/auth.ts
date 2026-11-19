/**
 * routes/auth.ts — Login, renovación de token, cierre de sesión.
 *
 * - accessToken: JWT de 15 min (viaja en cada petición y en el `auth` del WebSocket).
 * - refreshToken: aleatorio, 30 días, UN solo uso (se rota en cada renovación).
 *   Si alguien intenta reutilizar uno ya usado, se rechaza.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { authenticate } from "./../auth";
import type { AuthUser, LoginResponse, Role } from "../contract";
import type { Db } from "../db/client";
import { refreshTokens, users } from "../db/schema";
import { AppError } from "../errors";
import { getDummyHash, randomToken, sha256, verifyPassword } from "../security";

const ACCESS_TTL = "15m";
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function authRoutes(app: FastifyInstance, db: Db) {
  const toUser = (row: { id: string; name: string; role: Role }): AuthUser => ({
    id: row.id,
    name: row.name,
    role: row.role,
  });

  const signAccess = (user: AuthUser) =>
    app.jwt.sign({ sub: user.id, name: user.name, role: user.role }, { expiresIn: ACCESS_TTL });

  async function issueRefresh(userId: string): Promise<string> {
    const token = randomToken(48);
    await db.insert(refreshTokens).values({
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    });
    return token;
  }

  app.post<{ Body: { email: string; password: string } }>(
    "/api/auth/login",
    {
      // 10 intentos por minuto y por IP: frena los ataques de fuerza bruta.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", minLength: 3, maxLength: 254 },
            password: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request): Promise<LoginResponse> => {
      const email = request.body.email.trim().toLowerCase();
      const [row] = await db.select().from(users).where(eq(users.email, email));

      // Con o sin usuario se hace el mismo trabajo y se da el mismo mensaje:
      // así no se puede averiguar qué correos existen.
      const ok = await verifyPassword(request.body.password, row?.passwordHash ?? (await getDummyHash()));
      if (!row || !row.active || !ok) {
        throw new AppError(401, "invalid_credentials", "Correo o contraseña incorrectos.");
      }

      const user = toUser(row);
      return { accessToken: signAccess(user), refreshToken: await issueRefresh(row.id), user };
    },
  );

  app.post<{ Body: { refreshToken: string } }>(
    "/api/auth/refresh",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["refreshToken"],
          properties: { refreshToken: { type: "string", minLength: 20, maxLength: 200 } },
        },
      },
    },
    async (request) => {
      const hash = sha256(request.body.refreshToken);
      const [stored] = await db
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.tokenHash, hash), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())));
      if (!stored) throw new AppError(401, "invalid_refresh", "La sesión ya no es válida. Ingresa de nuevo.");

      const [row] = await db.select().from(users).where(eq(users.id, stored.userId));
      if (!row || !row.active) throw new AppError(401, "invalid_refresh", "La sesión ya no es válida. Ingresa de nuevo.");

      // Rotación: el token usado se revoca y se entrega uno nuevo.
      await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, stored.id));
      const user = toUser(row);
      return { accessToken: signAccess(user), refreshToken: await issueRefresh(row.id) };
    },
  );

  app.post<{ Body: { refreshToken?: string } }>("/api/auth/logout", async (request, reply) => {
    if (request.body?.refreshToken) {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.tokenHash, sha256(request.body.refreshToken)), isNull(refreshTokens.revokedAt)));
    }
    return reply.status(204).send();
  });

  app.get("/api/auth/me", { preHandler: [authenticate] }, async (request) => ({
    user: { id: request.user.sub, name: request.user.name, role: request.user.role },
  }));
}
