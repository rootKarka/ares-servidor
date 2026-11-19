/**
 * routes/robots.ts — Robots, sensores/umbrales e histórico de lecturas.
 */
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { authenticate, requireRole } from "../auth";
import type { RobotSummary, SensorConfig, SensorKind } from "../contract";
import type { Db } from "../db/client";
import { readings, robots, sensors } from "../db/schema";
import { AppError } from "../errors";
import type { Hub } from "../hub";
import { validThresholds } from "../levels";

type RobotRow = typeof robots.$inferSelect;

function summarize(row: RobotRow, hub: Hub): RobotSummary {
  const devices = hub.devicesOf(row.id);
  const status = !devices.data ? "offline" : row.onMission ? "mission" : "available";
  const live = hub.lastStatus.get(row.id);
  const last = live ? (({ ts: _ts, ...rest }) => rest)(live) : (row.lastStatus ?? undefined);
  return { robotId: row.id, name: row.name, status, devices, ...(last ? { last } : {}) };
}

export async function robotRoutes(app: FastifyInstance, db: Db, hub: Hub) {
  async function findRobot(robotId: string): Promise<RobotRow> {
    const [row] = await db.select().from(robots).where(eq(robots.id, robotId));
    if (!row) throw new AppError(404, "robot_not_found", "El robot no existe.");
    return row;
  }

  app.get("/api/robots", { preHandler: [authenticate] }, async () => {
    const rows = await db.select().from(robots).orderBy(robots.name);
    return { robots: rows.map((row) => summarize(row, hub)) };
  });

  app.get<{ Params: { robotId: string } }>("/api/robots/:robotId", { preHandler: [authenticate] }, async (request) =>
    summarize(await findRobot(request.params.robotId), hub),
  );

  app.get<{ Params: { robotId: string } }>(
    "/api/robots/:robotId/sensors",
    { preHandler: [authenticate] },
    async (request) => {
      await findRobot(request.params.robotId);
      const rows = await db.select().from(sensors).where(eq(sensors.robotId, request.params.robotId)).orderBy(sensors.sensor);
      const list: SensorConfig[] = rows.map((row) => ({
        sensor: row.sensor,
        kind: row.kind,
        direction: row.direction,
        warn: row.warn,
        crit: row.crit,
      }));
      return { sensors: list };
    },
  );

  app.put<{
    Params: { robotId: string; sensor: string };
    Body: { warn: number; crit: number; direction: "above" | "below" };
  }>(
    "/api/robots/:robotId/sensors/:sensor/thresholds",
    {
      preHandler: [requireRole("admin", "operador")],
      schema: {
        body: {
          type: "object",
          required: ["warn", "crit", "direction"],
          properties: {
            warn: { type: "number" },
            crit: { type: "number" },
            direction: { type: "string", enum: ["above", "below"] },
          },
        },
      },
    },
    async (request) => {
      const { robotId, sensor } = request.params;
      const body = request.body;
      if (!validThresholds(body)) {
        throw new AppError(
          400,
          "invalid_thresholds",
          body.direction === "above"
            ? "La advertencia debe ser menor que el valor crítico."
            : "La advertencia debe ser mayor que el valor crítico.",
        );
      }
      const [updated] = await db
        .update(sensors)
        .set({ warn: body.warn, crit: body.crit, direction: body.direction })
        .where(and(eq(sensors.robotId, robotId), eq(sensors.sensor, sensor)))
        .returning();
      if (!updated) throw new AppError(404, "sensor_not_found", "El sensor no existe en este robot.");

      hub.invalidateConfigs(robotId); // la siguiente lectura ya usa los umbrales nuevos
      const config: SensorConfig = {
        sensor: updated.sensor,
        kind: updated.kind,
        direction: updated.direction,
        warn: updated.warn,
        crit: updated.crit,
      };
      return config;
    },
  );

  app.get<{
    Params: { robotId: string };
    Querystring: { sensor?: string; from?: string; to?: string; limit?: number };
  }>(
    "/api/robots/:robotId/readings",
    {
      preHandler: [authenticate],
      schema: {
        querystring: {
          type: "object",
          properties: {
            sensor: { type: "string", maxLength: 40 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
          },
        },
      },
    },
    async (request) => {
      await findRobot(request.params.robotId);
      const { sensor, from, to, limit = 100 } = request.query;
      const rows = await db
        .select()
        .from(readings)
        .where(
          and(
            eq(readings.robotId, request.params.robotId),
            sensor ? eq(readings.sensor, sensor) : undefined,
            from ? gte(readings.ts, new Date(from)) : undefined,
            to ? lte(readings.ts, new Date(to)) : undefined,
          ),
        )
        .orderBy(desc(readings.ts))
        .limit(limit);
      return {
        readings: rows.map((row) => ({
          sensor: row.sensor,
          kind: row.kind as SensorKind,
          value: row.value,
          level: row.level,
          ts: row.ts.toISOString(),
        })),
      };
    },
  );
}
