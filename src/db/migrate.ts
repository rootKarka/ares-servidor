/** npm run db:migrate — aplica las migraciones SQL pendientes. */
import { pool } from "./client";
import { runMigrations } from "./runMigrations";

try {
  await runMigrations();
  console.log("✔ Migraciones aplicadas");
} catch (error) {
  console.error("✘ No se pudieron aplicar las migraciones:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
