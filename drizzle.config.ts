import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Solo lo usa `npm run db:generate` (crea los archivos SQL de la carpeta /drizzle
// a partir de src/db/schema.ts). La base real se actualiza con `npm run db:migrate`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://ares:ares_dev_password@localhost:5432/ares",
  },
});
