/**
 * telemetry.ts — Qué hace el servidor con cada mensaje del robot.
 *
 * Telemetría: valida, calcula el nivel de cada lectura con los umbrales de la base,
 * genera/cierra alertas cuando cambia el nivel, guarda el histórico (una lectura por
 * sensor cada 5 s, o al instante si cambia el nivel) y reenvía a las webs suscritas.
 *
 * Status: valida, lo guarda como "último conocido" y lo reenvía.
 */
import { eq } from "drizzle-orm";
import type { Level, LeveledReading, Reading, SensorKind, Status } from "./contract";
import type { Db } from "./db/client";
import { alerts, readings, robots } from "./db/schema";
import type { Hub } from "./hub";
import { evaluateLevel } from "./levels";

const KINDS: SensorKind[] = ["gas", "temperature", "humidity", "distance"];
const UNITS = ["ppm", "C", "%", "cm"];
const PERSIST_EVERY_MS = 5_000;
const STATUS_PERSIST_EVERY_MS = 30_000;
const MAX_READINGS = 32;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Descarta lecturas mal formadas en vez de rechazar todo el mensaje. */
export function sanitizeReadings(input: unknown): Reading[] {
  if (!Array.isArray(input)) return [];
  const out: Reading[] = [];
  for (const item of input.slice(0, MAX_READINGS)) {
    if (!isObject(item)) continue;
    const { sensor, kind, unit } = item;
    const value = num(item.value);
    if (typeof sensor !== "string" || sensor.length === 0 || sensor.length > 40) continue;
    if (typeof kind !== "string" || !KINDS.includes(kind as SensorKind)) continue;
    if (typeof unit !== "string" || !UNITS.includes(unit)) continue;
    if (value === undefined) continue;
    const raw = num(item.raw);
    out.push({
      sensor,
      kind: kind as SensorKind,
      unit: unit as Reading["unit"],
      value,
      ...(raw !== undefined ? { raw } : {}),
    });
  }
  return out;
}

export function sanitizeStatus(input: Record<string, unknown>): Status {
  const status: Status = {};
  if (isObject(input.battery)) {
    const percent = num(input.battery.percent);
    const voltage = num(input.battery.voltage);
    status.battery = {
      ...(percent !== undefined ? { percent: Math.min(100, Math.max(0, percent)) } : {}),
      ...(voltage !== undefined ? { voltage } : {}),
    };
  }
  if (isObject(input.net)) {
    const rssi = num(input.net.rssi);
    if (rssi !== undefined) status.net = { rssi };
  }
  if (isObject(input.gps)) {
    const lat = num(input.gps.lat);
    const lon = num(input.gps.lon);
    if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      const sats = num(input.gps.sats);
      status.gps = { lat, lon, fix: input.gps.fix === true, ...(sats !== undefined ? { sats } : {}) };
    }
  }
  if (isObject(input.imu)) {
    const pitch = num(input.imu.pitch);
    const roll = num(input.imu.roll);
    if (pitch !== undefined && roll !== undefined) status.imu = { pitch, roll };
  }
  if (input.mode === "manual" || input.mode === "autonomo") status.mode = input.mode;
  const speed = num(input.speed);
  if (speed !== undefined) status.speed = speed;
  const uptimeMs = num(input.uptimeMs);
  if (uptimeMs !== undefined) status.uptimeMs = uptimeMs;
  return status;
}

let alertCounter = 0;
const newAlertId = () => `a-${Date.now().toString(36)}${(alertCounter++).toString(36)}`;

export async function processTelemetry(hub: Hub, db: Db, robotId: string, rawReadings: unknown): Promise<void> {
  const input = sanitizeReadings(rawReadings);
  if (input.length === 0) return;

  const configs = await hub.getSensorConfigs(robotId);
  const now = Date.now();
  const leveled: LeveledReading[] = [];

  for (const reading of input) {
    const key = `${robotId}|${reading.sensor}|${reading.kind}`;
    const config = configs.get(reading.sensor);
    const previous = hub.levels.get(key);

    // Solo la magnitud principal de cada sensor tiene umbral (en el DHT11, la temperatura).
    let level: Level = "normal";
    if (config && config.kind === reading.kind) {
      level = evaluateLevel(reading.value, config, previous);
      if (level !== (previous ?? "normal")) {
        emitAlert(hub, db, robotId, key, reading, level, config, now);
      }
    }
    hub.levels.set(key, level);
    leveled.push({ ...reading, level });

    // Histórico: cada 5 s por sensor, o enseguida si cambió el nivel.
    const last = hub.lastPersist.get(key) ?? 0;
    if (now - last >= PERSIST_EVERY_MS || level !== (previous ?? level)) {
      hub.lastPersist.set(key, now);
      void db
        .insert(readings)
        .values({ robotId, sensor: reading.sensor, kind: reading.kind, value: reading.value, level, ts: new Date(now) })
        .catch((error: unknown) => hub.log.error({ error }, "No se pudo guardar la lectura"));
    }
  }

  hub.toSubscribers(robotId, "telemetry", { type: "telemetry", v: 1, robotId, ts: now, readings: leveled });
}

function emitAlert(
  hub: Hub,
  db: Db,
  robotId: string,
  key: string,
  reading: Reading,
  level: Level,
  config: { warn: number; crit: number },
  now: number,
): void {
  const cleared = level === "normal";
  const id = hub.openAlerts.get(key) ?? newAlertId();
  if (cleared) hub.openAlerts.delete(key);
  else hub.openAlerts.set(key, id);

  const threshold = level === "critical" ? config.crit : config.warn;
  hub.broadcast({
    type: "alert",
    v: 1,
    id,
    robotId,
    sensor: reading.sensor,
    kind: reading.kind,
    level,
    state: cleared ? "cleared" : "open",
    value: reading.value,
    threshold,
    ts: now,
  });
  void db
    .insert(alerts)
    .values({
      alertId: id,
      robotId,
      sensor: reading.sensor,
      kind: reading.kind,
      level,
      state: cleared ? "cleared" : "open",
      value: reading.value,
      threshold,
      ts: new Date(now),
    })
    .catch((error: unknown) => hub.log.error({ error }, "No se pudo guardar la alerta"));
}

export async function processStatus(hub: Hub, db: Db, robotId: string, message: Record<string, unknown>): Promise<void> {
  const status = sanitizeStatus(message);
  const now = Date.now();
  hub.lastStatus.set(robotId, { ...status, ts: now });
  hub.toSubscribers(robotId, "status", { type: "status", v: 1, robotId, ts: now, ...status });

  const key = `${robotId}|status`;
  if (now - (hub.lastPersist.get(key) ?? 0) >= STATUS_PERSIST_EVERY_MS) {
    hub.lastPersist.set(key, now);
    await db.update(robots).set({ lastStatus: status, lastSeenAt: new Date(now) }).where(eq(robots.id, robotId));
  }
}
