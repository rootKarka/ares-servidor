/**
 * server.ts — Punto de entrada.   npm run dev
 */
import { buildApp } from "./app";
import { pool } from "./db/client";
import { runMigrations } from "./db/runMigrations";
import { serverConfig } from "./env";

const config = serverConfig();
await runMigrations(); // deja la base al día cada vez que arranca
const { app } = await buildApp(config);

async function shutdown(signal: string) {
  app.log.info(`${signal} recibido, cerrando…`);
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.port, host: config.host });
app.log.info(`API:        http://localhost:${config.port}`);
app.log.info(`WS web:     ws://localhost:${config.port}/ws/web`);
app.log.info(`WS robot:   ws://localhost:${config.port}/ws/robot`);
