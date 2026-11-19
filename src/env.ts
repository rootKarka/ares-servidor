/**
 * env.ts — Lee la configuración del archivo .env (ver .env.example).
 */
import "dotenv/config";

export const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://ares:ares_dev_password@localhost:5432/ares";

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta ${name} en el archivo .env (mira .env.example).`);
  return value;
}

/** Configuración del servidor HTTP/WebSocket. Falla pronto si falta algo crítico. */
export function serverConfig() {
  const jwtSecret = requiredEnv("JWT_SECRET");
  if (jwtSecret.length < 32) {
    throw new Error("JWT_SECRET debe tener al menos 32 caracteres (mira .env.example).");
  }
  return {
    port: Number(process.env.PORT ?? 4000),
    host: process.env.HOST ?? "0.0.0.0",
    jwtSecret,
    corsOrigins: (
      process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:8080,http://localhost:3000"
    )
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    isDev: process.env.NODE_ENV !== "production",
  };
}

export type ServerConfig = ReturnType<typeof serverConfig>;
