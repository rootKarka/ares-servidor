import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { databaseUrl } from "../env";
import * as schema from "./schema";

export const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
export const db = drizzle(pool, { schema });
export type Db = typeof db;
