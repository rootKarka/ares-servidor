/**
 * schema.ts — Tablas de la base de datos (PostgreSQL, vía Drizzle ORM).
 *
 * Si cambias algo aquí:  npm run db:generate  (crea el SQL en /drizzle)
 *                        npm run db:migrate   (lo aplica a la base)
 */
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Role, SensorKind, Status } from "../contract";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(), // siempre en minúsculas
  name: text("name").notNull(),
  role: text("role").$type<Role>().notNull(),
  passwordHash: text("password_hash").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: tz("created_at").notNull().defaultNow(),
});

/** Tokens de refresco: solo se guarda el hash, y se rotan en cada uso. */
export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: tz("expires_at").notNull(),
  revokedAt: tz("revoked_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const robots = pgTable("robots", {
  id: text("id").primaryKey(), // robotId, ej. "delta-force"
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(), // hash del token que usan las ESP32
  onMission: boolean("on_mission").notNull().default(false),
  lastStatus: jsonb("last_status").$type<Status>(),
  lastSeenAt: tz("last_seen_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

/** Un sensor físico por fila, con sus umbrales (los edita la pantalla Sensores). */
export const sensors = pgTable(
  "sensors",
  {
    robotId: text("robot_id")
      .notNull()
      .references(() => robots.id, { onDelete: "cascade" }),
    sensor: text("sensor").notNull(), // "mq2-a", "dht11-a"...
    kind: text("kind").$type<SensorKind>().notNull(),
    direction: text("direction").$type<"above" | "below">().notNull(),
    warn: doublePrecision("warn").notNull(),
    crit: doublePrecision("crit").notNull(),
  },
  (t) => [primaryKey({ columns: [t.robotId, t.sensor] })],
);

/** Histórico: una lectura por sensor cada 5 s (y siempre que cambie el nivel). */
export const readings = pgTable(
  "readings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    robotId: text("robot_id").notNull(),
    sensor: text("sensor").notNull(),
    kind: text("kind").$type<SensorKind>().notNull(),
    value: doublePrecision("value").notNull(),
    level: text("level").notNull(),
    ts: tz("ts").notNull().defaultNow(),
  },
  (t) => [index("readings_robot_sensor_ts").on(t.robotId, t.sensor, t.ts)],
);

/** Eventos de alerta (abierta / cerrada). `alertId` agrupa los eventos de un mismo incidente. */
export const alerts = pgTable(
  "alerts",
  {
    eventId: bigserial("event_id", { mode: "number" }).primaryKey(),
    alertId: text("alert_id").notNull(),
    robotId: text("robot_id").notNull(),
    sensor: text("sensor").notNull(),
    kind: text("kind").$type<SensorKind>().notNull(),
    level: text("level").notNull(),
    state: text("state").$type<"open" | "cleared">().notNull(),
    value: doublePrecision("value").notNull(),
    threshold: doublePrecision("threshold").notNull(),
    ts: tz("ts").notNull().defaultNow(),
  },
  (t) => [index("alerts_robot_ts").on(t.robotId, t.ts)],
);
