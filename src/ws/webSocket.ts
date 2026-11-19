/**
 * ws/webSocket.ts — WebSocket de las webs (campo y administración):  wss://HOST/ws/web
 *
 * Flujo (contrato, sección 5.3 y 5.4):
 *   1. La web manda `auth` con su JWT (dentro de 5 s) y recibe `ready`.
 *   2. Manda `subscribe` con el robot y los streams que quiere (telemetry, status, video, audio).
 *   3. Recibe telemetría/status/alertas/presencia (JSON) y audio/video (binario).
 *   4. `ptt.start` / `ptt.stop` para hablar al robot; entonces manda frames binarios 0x02.
 *   5. `ping` -> `pong` para medir la latencia.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import type { JwtPayload } from "../auth";
import type { StreamName } from "../contract";
import type { Db } from "../db/client";
import { robots, users } from "../db/schema";
import type { Hub, WebClient } from "../hub";

const AUTH_TIMEOUT_MS = 5_000;
const MAX_VOICE_FRAME = 8 * 1024;
const STREAMS: StreamName[] = ["telemetry", "status", "video", "audio"];

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function registerWebSocket(app: FastifyInstance, db: Db, hub: Hub): void {
  app.get("/ws/web", { websocket: true }, (socket) => {
    let client: WebClient | null = null;
    let queue: Promise<void> = Promise.resolve();

    const authTimer = setTimeout(() => {
      if (!client) socket.close(4408, "auth_timeout");
    }, AUTH_TIMEOUT_MS);

    const sendError = (code: string, message?: string) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "error", v: 1, code, ...(message ? { message } : {}) }));
      }
    };

    async function handleAuth(msg: Record<string, unknown>): Promise<void> {
      try {
        if (typeof msg.token !== "string") throw new Error("sin token");
        const payload = app.jwt.verify<JwtPayload>(msg.token);
        const [row] = await db.select().from(users).where(eq(users.id, payload.sub));
        if (!row || !row.active) throw new Error("usuario inactivo");

        client = hub.addWeb(socket, { id: row.id, name: row.name, role: row.role });
        socket.send(JSON.stringify({ type: "ready", v: 1, user: client.user }));
        // Quién está conectado ahora mismo (después solo llegan los cambios).
        for (const presence of hub.presenceSnapshot()) hub.sendWeb(client, presence);
      } catch {
        sendError("auth_failed", "Sesión inválida o expirada.");
        socket.close(4401, "auth_failed");
      }
    }

    async function handleSubscribe(current: WebClient, msg: Record<string, unknown>): Promise<void> {
      if (typeof msg.robotId !== "string" || !Array.isArray(msg.streams)) {
        return sendError("bad_message", "subscribe necesita robotId y streams.");
      }
      const robotId = msg.robotId;
      const streams = msg.streams.filter((s): s is StreamName => STREAMS.includes(s as StreamName));
      const [robot] = await db.select({ id: robots.id }).from(robots).where(eq(robots.id, robotId));
      if (!robot) return sendError("bad_message", "El robot no existe.");

      const previous = current.robotId;
      if (previous && previous !== robotId) hub.releasePttOf(current); // cambió de robot: suelta el turno
      current.robotId = robotId;
      current.streams = new Set(streams);

      hub.sendWeb(current, { type: "subscribed", v: 1, robotId, online: hub.devicesOf(robotId) });
      const last = hub.lastStatus.get(robotId);
      if (last && current.streams.has("status")) hub.sendWeb(current, { type: "status", v: 1, robotId, ...last });

      hub.reconcileDemand(robotId);
      if (previous && previous !== robotId) hub.reconcileDemand(previous);
    }

    function handleUnsubscribe(current: WebClient): void {
      const previous = current.robotId;
      hub.releasePttOf(current);
      current.robotId = null;
      current.streams.clear();
      if (previous) hub.reconcileDemand(previous);
    }

    async function handle(data: RawData, isBinary: boolean): Promise<void> {
      if (isBinary) {
        // Voz del operador (0x02): solo se acepta si tiene el turno de hablar.
        const frame = toBuffer(data);
        if (client && frame[0] === 0x02 && frame.length > 3 && frame.length <= MAX_VOICE_FRAME) {
          hub.forwardVoice(client, frame);
        }
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return sendError("bad_message", "El mensaje no es JSON válido.");
      }

      if (!client) {
        if (msg.type === "auth") await handleAuth(msg);
        else {
          sendError("auth_failed", "Primero envía auth.");
          socket.close(4401, "auth_failed");
        }
        return;
      }

      switch (msg.type) {
        case "subscribe":
          await handleSubscribe(client, msg);
          break;
        case "unsubscribe":
          handleUnsubscribe(client);
          break;
        case "ping":
          if (typeof msg.t === "number") socket.send(JSON.stringify({ type: "pong", v: 1, t: msg.t }));
          break;
        case "ptt.start":
          hub.sendWeb(client, hub.requestPtt(client));
          break;
        case "ptt.stop":
          if (client.robotId && hub.holdsPtt(client)) hub.releasePtt(client.robotId, "stop");
          break;
        default:
          sendError("bad_message", `Tipo de mensaje desconocido: ${String(msg.type)}`);
      }
    }

    // Los mensajes de una web se procesan de a uno, en orden (subscribe -> unsubscribe, etc.).
    socket.on("message", (data, isBinary) => {
      queue = queue
        .then(() => handle(data, isBinary))
        .catch((error: unknown) => {
          hub.log.error({ error }, "Error procesando mensaje de la web");
          sendError("bad_message", "No se pudo procesar el mensaje.");
        });
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (client) hub.removeWeb(client);
    });
    socket.on("error", (error) => hub.log.warn({ error }, "Error de socket (web)"));
  });
}
