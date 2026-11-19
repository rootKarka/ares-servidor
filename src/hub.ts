/**
 * hub.ts — El "punto de encuentro": quién está conectado y qué quiere recibir.
 *
 * Guarda en memoria (no en la base de datos, porque cambia cada segundo):
 *   - los sockets de cada robot (device "data" y device "cam"),
 *   - los sockets de las webs, con el robot y los streams a los que están suscritas,
 *   - el último status, el último nivel de cada sensor y las alertas abiertas,
 *   - quién tiene el turno de hablar (PTT) en cada robot.
 *
 * Reenvía telemetría, audio y video del robot a las webs suscritas, y le manda al
 * robot los comandos de empezar/parar video y audio SOLO cuando alguien los necesita.
 */
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type WebSocket from "ws";
import type {
  Device,
  Level,
  Role,
  SensorConfig,
  ServerToRobot,
  ServerToWeb,
  Status,
  StreamName,
} from "./contract";
import type { Db } from "./db/client";
import { sensors } from "./db/schema";

export interface WebClient {
  id: number;
  socket: WebSocket;
  user: { id: string; name: string; role: Role };
  /** Un socket web tiene un solo robot activo (contrato, sección 5.3). */
  robotId: string | null;
  streams: Set<StreamName>;
}

export interface RobotConn {
  socket: WebSocket;
  device: Device;
}

export type StatusSnapshot = Status & { ts: number };

const PTT_MAX_MS = 60_000;
/** Si el socket de una web acumula más de esto sin enviarse, se descartan frames (gana el último). */
const VIDEO_BACKPRESSURE_BYTES = 512 * 1024;
const AUDIO_BACKPRESSURE_BYTES = 256 * 1024;

export class Hub {
  readonly webs = new Set<WebClient>();
  readonly lastStatus = new Map<string, StatusSnapshot>();
  /** Último nivel de cada sensor ("robot|sensor|kind"), para detectar cambios y aplicar histéresis. */
  readonly levels = new Map<string, Level>();
  /** Alerta abierta de cada sensor, para cerrarla con el mismo id. */
  readonly openAlerts = new Map<string, string>();
  readonly lastPersist = new Map<string, number>();

  private robots = new Map<string, Partial<Record<Device, RobotConn>>>();
  private configs = new Map<string, Map<string, SensorConfig>>();
  /** Lo que ya le pedimos a cada robot (para no repetir video.start / audio.listen.start). */
  private demand = new Map<string, { video: boolean; audio: boolean }>();
  private ptt = new Map<string, { client: WebClient; timer: ReturnType<typeof setTimeout> }>();
  private nextClientId = 1;
  private cmdSeq = 0;

  constructor(
    private db: Db,
    readonly log: FastifyBaseLogger,
  ) {}

  /* ------------------------------- Robots (placas) ------------------------------- */

  devicesOf(robotId: string): { data: boolean; cam: boolean } {
    const conns = this.robots.get(robotId);
    return { data: !!conns?.data, cam: !!conns?.cam };
  }

  /** Registra la conexión. Devuelve la anterior (si la había) para que quien llama la cierre. */
  attachRobot(robotId: string, conn: RobotConn): RobotConn | undefined {
    const conns = this.robots.get(robotId) ?? {};
    const previous = conns[conn.device];
    conns[conn.device] = conn;
    this.robots.set(robotId, conns);
    return previous;
  }

  /** Quita la conexión SOLO si sigue siendo la vigente (una reconexión ya la reemplazó si no). */
  detachRobot(robotId: string, conn: RobotConn): boolean {
    const conns = this.robots.get(robotId);
    if (!conns || conns[conn.device] !== conn) return false;
    delete conns[conn.device];
    // La placa se fue: cuando vuelva hay que pedirle de nuevo el stream.
    const sent = this.demand.get(robotId);
    if (sent) {
      if (conn.device === "cam") sent.video = false;
      else sent.audio = false;
    }
    if (conn.device === "data") this.releasePtt(robotId, "disconnect");
    return true;
  }

  sendToRobot(conn: RobotConn, msg: ServerToRobot): void {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(JSON.stringify(msg));
  }

  private sendCmd(conn: RobotConn, name: Extract<ServerToRobot, { type: "cmd" }>["name"], args?: Record<string, unknown>) {
    this.sendToRobot(conn, { type: "cmd", v: 1, id: `c-${++this.cmdSeq}`, name, ...(args ? { args } : {}) });
  }

  /* ------------------------------------ Webs ------------------------------------- */

  addWeb(socket: WebSocket, user: WebClient["user"]): WebClient {
    const client: WebClient = { id: this.nextClientId++, socket, user, robotId: null, streams: new Set() };
    this.webs.add(client);
    return client;
  }

  removeWeb(client: WebClient): void {
    this.webs.delete(client);
    this.releasePttOf(client);
    if (client.robotId) this.reconcileDemand(client.robotId);
  }

  sendWeb(client: WebClient, msg: ServerToWeb): void {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(msg));
  }

  /** A todas las webs conectadas (presencia y alertas llegan siempre, sin suscribirse). */
  broadcast(msg: ServerToWeb): void {
    for (const client of this.webs) this.sendWeb(client, msg);
  }

  /** Solo a las webs cuyo robot activo es `robotId` y pidieron ese stream. */
  toSubscribers(robotId: string, stream: StreamName, msg: ServerToWeb): void {
    for (const client of this.webs) {
      if (client.robotId === robotId && client.streams.has(stream)) this.sendWeb(client, msg);
    }
  }

  /** Presencia actual de todos los robots, para una web que acaba de entrar. */
  presenceSnapshot(): ServerToWeb[] {
    const out: ServerToWeb[] = [];
    for (const [robotId, conns] of this.robots) {
      for (const device of ["data", "cam"] as const) {
        if (conns[device]) out.push({ type: "presence", v: 1, robotId, device, online: true, ts: Date.now() });
      }
    }
    return out;
  }

  /* ----------------------------- Audio y video (binario) ----------------------------- */

  /** Reenvía un frame del robot (micrófono 0x01 / video 0x03) a las webs suscritas. */
  forwardMedia(robotId: string, stream: "audio" | "video", frame: Buffer): void {
    const limit = stream === "video" ? VIDEO_BACKPRESSURE_BYTES : AUDIO_BACKPRESSURE_BYTES;
    for (const client of this.webs) {
      if (client.robotId !== robotId || !client.streams.has(stream)) continue;
      if (client.socket.readyState !== client.socket.OPEN) continue;
      if (client.socket.bufferedAmount > limit) continue; // web lenta: se salta este frame
      client.socket.send(frame, { binary: true });
    }
  }

  /** Reenvía la voz del operador (0x02) al robot, solo si ese operador tiene el turno. */
  forwardVoice(client: WebClient, frame: Buffer): void {
    if (!client.robotId) return;
    if (this.ptt.get(client.robotId)?.client !== client) return;
    const data = this.robots.get(client.robotId)?.data;
    if (!data || data.socket.readyState !== data.socket.OPEN) return;
    if (data.socket.bufferedAmount > AUDIO_BACKPRESSURE_BYTES) return;
    data.socket.send(frame, { binary: true });
  }

  /* ------------------------ Streams bajo demanda (cmd al robot) ------------------------ */

  /**
   * Compara lo que las webs necesitan con lo que ya se le pidió al robot y manda
   * video.start / video.stop (a la cam) y audio.listen.start / stop (a la placa de datos).
   */
  reconcileDemand(robotId: string): void {
    let video = false;
    let audio = false;
    for (const client of this.webs) {
      if (client.robotId !== robotId) continue;
      if (client.streams.has("video")) video = true;
      if (client.streams.has("audio")) audio = true;
    }
    const sent = this.demand.get(robotId) ?? { video: false, audio: false };
    const conns = this.robots.get(robotId) ?? {};

    // Solo se marca como "enviado" si la placa está conectada; si no, se pide al conectarse.
    if (conns.cam && sent.video !== video) {
      if (video) this.sendCmd(conns.cam, "video.start", { resolution: "QVGA", fps: 8, quality: 12 });
      else this.sendCmd(conns.cam, "video.stop");
      sent.video = video;
    }
    if (conns.data && sent.audio !== audio) {
      this.sendCmd(conns.data, audio ? "audio.listen.start" : "audio.listen.stop");
      sent.audio = audio;
    }
    this.demand.set(robotId, sent);
  }

  /* ------------------------------ Hablar al robot (PTT) ------------------------------ */

  requestPtt(client: WebClient): ServerToWeb {
    if (client.user.role === "observador") return { type: "ptt.denied", v: 1, reason: "forbidden" };
    const robotId = client.robotId;
    const data = robotId ? this.robots.get(robotId)?.data : undefined;
    if (!robotId || !data) return { type: "ptt.denied", v: 1, reason: "robot_offline" };

    const current = this.ptt.get(robotId);
    if (current && current.client !== client) {
      return { type: "ptt.denied", v: 1, reason: "busy", by: current.client.user.name };
    }
    if (current) clearTimeout(current.timer); // el mismo operador renueva su turno
    const timer = setTimeout(() => this.releasePtt(robotId, "timeout"), PTT_MAX_MS);
    this.ptt.set(robotId, { client, timer });
    if (!current) this.sendCmd(data, "audio.speak.start");
    return { type: "ptt.granted", v: 1 };
  }

  releasePtt(robotId: string, reason: "stop" | "timeout" | "disconnect"): void {
    const current = this.ptt.get(robotId);
    if (!current) return;
    clearTimeout(current.timer);
    this.ptt.delete(robotId);
    const data = this.robots.get(robotId)?.data;
    if (data) this.sendCmd(data, "audio.speak.stop");
    if (reason === "timeout") {
      this.sendWeb(current.client, {
        type: "error",
        v: 1,
        code: "ptt_timeout",
        message: "Se alcanzó el máximo de 60 s hablando. Vuelve a presionar para continuar.",
      });
    }
  }

  releasePttOf(client: WebClient): void {
    for (const [robotId, entry] of this.ptt) {
      if (entry.client === client) this.releasePtt(robotId, "stop");
    }
  }

  holdsPtt(client: WebClient): boolean {
    return !!client.robotId && this.ptt.get(client.robotId)?.client === client;
  }

  /* ---------------------------- Configuración de sensores ---------------------------- */

  async getSensorConfigs(robotId: string): Promise<Map<string, SensorConfig>> {
    const cached = this.configs.get(robotId);
    if (cached) return cached;
    const rows = await this.db.select().from(sensors).where(eq(sensors.robotId, robotId));
    const map = new Map(
      rows.map((row) => [
        row.sensor,
        { sensor: row.sensor, kind: row.kind, direction: row.direction, warn: row.warn, crit: row.crit },
      ]),
    );
    this.configs.set(robotId, map);
    return map;
  }

  invalidateConfigs(robotId: string): void {
    this.configs.delete(robotId);
  }

  async getSensorConfig(robotId: string, sensor: string): Promise<SensorConfig | undefined> {
    return (await this.getSensorConfigs(robotId)).get(sensor);
  }
}
