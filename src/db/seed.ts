/**
 * seed.ts — Datos iniciales.   npm run db:seed
 *
 * Crea (o actualiza) dos usuarios, tres robots y los sensores de cada robot.
 * Se puede ejecutar varias veces sin duplicar nada.
 *
 * Las contraseñas salen del .env (SEED_*_PASSWORD) y se guardan cifradas.
 * El token de cada robot nuevo se imprime UNA sola vez: cópialo al config.h de la ESP32
 * (y a SIM_ROBOT_TOKEN para el simulador). En la base solo queda su hash.
 */
import { eq } from "drizzle-orm";
import { requiredEnv } from "../env";
import { hashPassword, randomToken, sha256 } from "../security";
import type { Role, SensorConfig } from "../contract";
import { db, pool } from "./client";
import { robots, sensors, users } from "./schema";

/** Sensores de cada robot, con los umbrales iniciales del contrato (editables desde la web). */
const SENSOR_TEMPLATE: SensorConfig[] = [
  { sensor: "mq2-a", kind: "gas", direction: "above", warn: 300, crit: 600 },
  { sensor: "mq2-b", kind: "gas", direction: "above", warn: 300, crit: 600 },
  { sensor: "hcsr04-a", kind: "distance", direction: "below", warn: 50, crit: 20 },
  { sensor: "dht11-a", kind: "temperature", direction: "above", warn: 40, crit: 55 },
  { sensor: "dht11-b", kind: "temperature", direction: "above", warn: 40, crit: 55 },
];

const ROBOTS = [
  { id: "delta-force", name: "DELTA FORCE", onMission: true },
  { id: "atlas-02", name: "ATLAS-02", onMission: false },
  { id: "nova-03", name: "NOVA-03", onMission: false },
];

function password(name: string): string {
  const value = requiredEnv(name);
  if (value.length < 8) throw new Error(`${name} debe tener al menos 8 caracteres.`);
  return value;
}

async function upsertUser(email: string, name: string, role: Role, plainPassword: string) {
  const passwordHash = await hashPassword(plainPassword);
  await db
    .insert(users)
    .values({ email: email.toLowerCase(), name, role, passwordHash })
    .onConflictDoUpdate({
      target: users.email,
      set: { name, role, passwordHash, active: true },
    });
  console.log(`✔ Usuario ${role}: ${email.toLowerCase()}`);
}

async function main() {
  await upsertUser(
    requiredEnv("SEED_ADMIN_EMAIL"),
    process.env.SEED_ADMIN_NAME?.trim() || "Administrador",
    "admin",
    password("SEED_ADMIN_PASSWORD"),
  );
  await upsertUser(
    requiredEnv("SEED_OPERATOR_EMAIL"),
    process.env.SEED_OPERATOR_NAME?.trim() || "Operador",
    "operador",
    password("SEED_OPERATOR_PASSWORD"),
  );

  for (const robot of ROBOTS) {
    const [existing] = await db.select().from(robots).where(eq(robots.id, robot.id));
    const fixedToken = robot.id === "delta-force" ? process.env.SEED_ROBOT_TOKEN?.trim() : undefined;
    if (fixedToken && fixedToken.length < 24) {
      throw new Error("SEED_ROBOT_TOKEN debe tener al menos 24 caracteres (o déjalo vacío).");
    }

    if (!existing) {
      const token = fixedToken || randomToken();
      await db.insert(robots).values({ ...robot, tokenHash: sha256(token) });
      console.log(`✔ Robot ${robot.id} creado`);
      if (!fixedToken) console.log(`   TOKEN (cópialo ahora, no se vuelve a mostrar): ${token}`);
    } else if (fixedToken) {
      await db.update(robots).set({ name: robot.name, tokenHash: sha256(fixedToken) }).where(eq(robots.id, robot.id));
      console.log(`✔ Robot ${robot.id} actualizado (token tomado de SEED_ROBOT_TOKEN)`);
    } else {
      console.log(`• Robot ${robot.id} ya existía (su token no cambia)`);
    }

    await db
      .insert(sensors)
      .values(SENSOR_TEMPLATE.map((sensor) => ({ robotId: robot.id, ...sensor })))
      .onConflictDoNothing();
  }
}

try {
  await main();
  console.log("✔ Datos iniciales listos");
} catch (error) {
  console.error("✘ Error en el seed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
