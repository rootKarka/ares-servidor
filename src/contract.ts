/**
 * contract.ts — Contrato de comunicación ARES v1 (+ ajustes v1.1)
 *
 * Este archivo es la ÚNICA fuente de verdad de los mensajes entre la web, el
 * servidor y el robot. Cópialo tal cual al servidor (shared/contract.ts) para
 * que ambos lados compartan los mismos tipos.
 *
 * Ajustes v1.1 respecto al documento original (aditivos, no rompen v1):
 *  - ping / pong (web <-> servidor) para medir la latencia.
 *  - DTOs REST: AuthUser, LoginResponse, RobotSummary, SensorConfig.
 */

export type Level = "normal" | "warning" | "critical" | "offline";
export type SensorKind = "gas" | "temperature" | "humidity" | "distance";
export type Role = "admin" | "operador" | "observador";
export type Device = "data" | "cam";
export type StreamName = "telemetry" | "status" | "video" | "audio";

export interface Reading {
  sensor: string;
  kind: SensorKind;
  value: number;
  unit: "ppm" | "C" | "%" | "cm";
  raw?: number;
}
export interface LeveledReading extends Reading {
  level: Level;
}

export interface Status {
  battery?: { percent?: number; voltage?: number };
  net?: { rssi?: number };
  gps?: { lat: number; lon: number; sats?: number; fix: boolean };
  imu?: { pitch: number; roll: number };
  mode?: "manual" | "autonomo";
  speed?: number;
  uptimeMs?: number;
}

export interface ChatMessage {
  id: string;
  from: { id: string; name: string };
  text: string;
  evidenceId: string | null;
  ts: number;
}

type Base = { v: 1 };

/* ----------------------------- Robot <-> servidor ----------------------------- */

export type RobotToServer =
  | (Base & { type: "hello"; robotId: string; device: Device; token: string; fw?: string })
  | (Base & { type: "telemetry"; readings: Reading[] })
  | (Base & { type: "status" } & Status)
  | (Base & { type: "ack"; id: string; ok: boolean; error?: string });

export type ServerToRobot =
  | (Base & { type: "welcome"; serverTime: number; telemetryEveryMs: number; statusEveryMs: number })
  | (Base & {
      type: "cmd";
      id: string;
      name:
        | "video.start"
        | "video.stop"
        | "audio.listen.start"
        | "audio.listen.stop"
        | "audio.speak.start"
        | "audio.speak.stop";
      args?: Record<string, unknown>;
    })
  | (Base & { type: "error"; code: string; message?: string });

/* ------------------------------- Web <-> servidor ------------------------------ */

export type WebToServer =
  | (Base & { type: "auth"; token: string })
  | (Base & { type: "subscribe"; robotId: string; streams: StreamName[] })
  | (Base & { type: "unsubscribe" })
  | (Base & { type: "ptt.start" })
  | (Base & { type: "ptt.stop" })
  | (Base & { type: "ping"; t: number }); // v1.1

export type ServerToWeb =
  | (Base & { type: "ready"; user: { id: string; name: string; role: Role } })
  | (Base & { type: "subscribed"; robotId: string; online: { data: boolean; cam: boolean } })
  | (Base & { type: "telemetry"; robotId: string; ts: number; readings: LeveledReading[] })
  | (Base & { type: "status"; robotId: string; ts: number } & Status)
  | (Base & { type: "presence"; robotId: string; device: Device; online: boolean; ts: number })
  | (Base & {
      type: "alert";
      id: string;
      robotId: string;
      sensor: string;
      kind: SensorKind;
      level: Level;
      state: "open" | "cleared";
      value: number;
      threshold: number;
      ts: number;
    })
  | (Base & { type: "ptt.granted" })
  | (Base & { type: "ptt.denied"; reason: "busy" | "forbidden" | "robot_offline"; by?: string })
  | (Base & { type: "message.new"; conversationId: string; message: ChatMessage })
  | (Base & { type: "pong"; t: number }) // v1.1: el servidor devuelve el mismo `t`
  | (Base & { type: "error"; code: string; message?: string });

/* ----------------------------------- REST DTOs ---------------------------------- */

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
}
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

/** GET /api/robots y GET /api/robots/:robotId */
export interface RobotSummary {
  robotId: string;
  name: string;
  status: "available" | "mission" | "offline";
  devices: { data: boolean; cam: boolean };
  /** Último status conocido, para pintar la lista sin estar suscrito. */
  last?: Status;
}

/**
 * GET /api/robots/:robotId/sensors -> { sensors: SensorConfig[] }
 * Un elemento por sensor físico. Para el DHT11 el umbral aplica a la temperatura
 * (kind = "temperature"); la humedad no tiene umbral.
 */
export interface SensorConfig {
  sensor: string;
  kind: SensorKind;
  direction: "above" | "below";
  warn: number;
  crit: number;
}

/* ------------------------------- Frames binarios -------------------------------- */

export const STREAM = { MIC: 0x01, VOICE: 0x02, VIDEO: 0x03 } as const;

/** Cabecera de 3 bytes: [tipo][seq uint16 little-endian] + contenido. */
export function parseFrame(buf: ArrayBuffer) {
  const b = new DataView(buf);
  return { stream: b.getUint8(0), seq: b.getUint16(1, true), payload: buf.slice(3) };
}
export type BinaryFrame = ReturnType<typeof parseFrame>;
