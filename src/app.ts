/**
 * app.ts — Arma el servidor Fastify: plugins, rutas REST y los dos WebSockets.
 */
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type WebSocket from "ws";
import { authRoutes } from "./routes/auth";
import { robotRoutes } from "./routes/robots";
import { db } from "./db/client";
import type { ServerConfig } from "./env";
import { errorHandler } from "./errors";
import { Hub } from "./hub";
import { registerRobotSocket } from "./ws/robotSocket";
import { registerWebSocket } from "./ws/webSocket";

const HEARTBEAT_MS = 15_000;

export async function buildApp(config: ServerConfig) {
  const app = Fastify({
    trustProxy: true, // detrás de Render/Fly/Nginx, para ver la IP real (límite de intentos)
    logger: {
      level: "info",
      ...(config.isDev
        ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }
        : {}),
    },
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: "not_found", message: "Ruta no encontrada." } }),
  );

  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  await app.register(rateLimit, { global: false }); // solo en las rutas que lo piden (login)
  await app.register(jwt, { secret: config.jwtSecret });
  // maxPayload: el frame de video más grande permitido son 64 KB; 1 MB deja margen de sobra.
  await app.register(websocket, { options: { maxPayload: 1_048_576 } });

  const hub = new Hub(db, app.log);

  app.get("/health", async () => ({ ok: true, time: new Date().toISOString() }));
  await authRoutes(app, db);
  await robotRoutes(app, db, hub);
  registerRobotSocket(app, db, hub);
  registerWebSocket(app, db, hub);

  // Latido: cada 15 s se hace ping a todos los sockets; el que no contestó desde el ping
  // anterior (15-30 s sin señales) se corta. Los navegadores y las ESP32 responden solos.
  const alive = new WeakMap<WebSocket, boolean>();
  app.websocketServer.on("connection", (ws: WebSocket) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  });
  const heartbeat = setInterval(() => {
    for (const ws of app.websocketServer.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  app.addHook("onClose", async () => clearInterval(heartbeat));

  return { app, hub };
}
