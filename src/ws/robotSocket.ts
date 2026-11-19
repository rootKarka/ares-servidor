/**
 * ws/robotSocket.ts — WebSocket de las placas del robot:  wss://HOST/ws/robot
 *
 * Flujo (contrato, sección 5.1):
 *   1. La placa conecta y manda `hello` con robotId, device ("data" o "cam") y token.
 *   2. El servidor valida el token contra el hash guardado y responde `welcome`.
 *   3. La placa de datos manda `telemetry` y `status`; ambas placas responden `ack`
 *      a los `cmd` y mandan frames binarios (micrófono 0x01 / video 0x03).
 *
 * Si la misma placa se vuelve a conectar (típico tras una caída del 4G, cuando el socket
 * viejo sigue "medio abierto"), la conexión NUEVA gana y la vieja se cierra con 4409.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import type { ServerToRobot } from "../contract";
import type { Db } from "../db/client";
import { robots } from "../db/schema";
import type { Hub, RobotConn } from "../hub";
import { safeEqualHex, sha256 } from "../security";
import { processStatus, processTelemetry } from "../telemetry";

const HELLO_TIMEOUT_MS = 5_000;
const MAX_VIDEO_FRAME = 64 * 1024 + 3;
const MAX_AUDIO_FRAME = 8 * 1024;

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function registerRobotSocket(app: FastifyInstance, db: Db, hub: Hub): void {
  app.get("/ws/robot", { websocket: true }, (socket) => {
    let conn: RobotConn | null = null;
    let robotId = "";
    let queue: Promise<void> = Promise.resolve();

    const helloTimer = setTimeout(() => {
      if (!conn) socket.close(4408, "hello_timeout");
    }, HELLO_TIMEOUT_MS);

    const send = (msg: ServerToRobot) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const reject = (code: string, closeCode: number) => {
      send({ type: "error", v: 1, code });
      socket.close(closeCode, code);
    };

    async function handleHello(msg: Record<string, unknown>): Promise<void> {
      const { robotId: id, device, token } = msg;
      if (typeof id !== "string" || (device !== "data" && device !== "cam") || typeof token !== "string") {
        return reject("auth_failed", 4401);
      }
      const [row] = await db.select({ tokenHash: robots.tokenHash }).from(robots).where(eq(robots.id, id));
      // Mismo error si el robot no existe o el token es incorrecto.
      if (!row || !safeEqualHex(row.tokenHash, sha256(token))) return reject("auth_failed", 4401);

      conn = { socket, device };
      robotId = id;
      const previous = hub.attachRobot(id, conn);
      previous?.socket.close(4409, "replaced");

      send({ type: "welcome", v: 1, serverTime: Date.now(), telemetryEveryMs: 1000, statusEveryMs: 2000 });
      hub.log.info({ robotId: id, device }, "Placa del robot conectada");
      hub.broadcast({ type: "presence", v: 1, robotId: id, device, online: true, ts: Date.now() });
      hub.reconcileDemand(id); // si alguien ya está mirando el video, se lo pedimos a la placa
      void db.update(robots).set({ lastSeenAt: new Date() }).where(eq(robots.id, id));
    }

    function handleBinary(frame: Buffer): void {
      if (!conn || frame.length < 4) return;
      const stream = frame[0];
      if (stream === 0x03 && conn.device === "cam" && frame.length <= MAX_VIDEO_FRAME) {
        hub.forwardMedia(robotId, "video", frame);
      } else if (stream === 0x01 && conn.device === "data" && frame.length <= MAX_AUDIO_FRAME) {
        hub.forwardMedia(robotId, "audio", frame);
      }
    }

    async function handle(data: RawData, isBinary: boolean): Promise<void> {
      if (isBinary) return handleBinary(toBuffer(data));
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!conn) {
        if (msg.type === "hello") await handleHello(msg);
        else reject("auth_failed", 4401); // el primer mensaje tiene que ser hello
        return;
      }
      switch (msg.type) {
        case "telemetry":
          if (conn.device === "data") await processTelemetry(hub, db, robotId, msg.readings);
          break;
        case "status":
          if (conn.device === "data") await processStatus(hub, db, robotId, msg);
          break;
        case "ack":
          if (msg.ok === false) hub.log.warn({ robotId, device: conn.device, ack: msg }, "El robot rechazó un comando");
          break;
        default:
          break;
      }
    }

    // Los mensajes de una placa se procesan de a uno, en orden.
    socket.on("message", (data, isBinary) => {
      queue = queue
        .then(() => handle(data, isBinary))
        .catch((error: unknown) => hub.log.error({ error, robotId }, "Error procesando mensaje del robot"));
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (!conn) return;
      // Si una reconexión ya reemplazó a esta conexión, detachRobot devuelve false y no se anuncia nada.
      if (hub.detachRobot(robotId, conn)) {
        hub.log.info({ robotId, device: conn.device }, "Placa del robot desconectada");
        hub.broadcast({ type: "presence", v: 1, robotId, device: conn.device, online: false, ts: Date.now() });
        void db.update(robots).set({ lastSeenAt: new Date() }).where(eq(robots.id, robotId));
      }
    });
    socket.on("error", (error) => hub.log.warn({ error, robotId }, "Error de socket (robot)"));
  });
}
