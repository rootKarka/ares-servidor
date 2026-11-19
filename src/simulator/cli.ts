/** npm run sim — arranca el robot simulado usando SIM_* del .env. */
import { requiredEnv } from "../env";
import { startSimulator } from "./sim";

const sim = startSimulator({
  url: process.env.SIM_SERVER_URL ?? "ws://localhost:4000/ws/robot",
  robotId: process.env.SIM_ROBOT_ID ?? "delta-force",
  token: requiredEnv("SIM_ROBOT_TOKEN"),
  cam: process.env.SIM_NO_CAM !== "1",
  gasPeriodS: Number(process.env.SIM_GAS_PERIOD_S ?? 60),
});

console.log("[sim] Robot simulado en marcha. Ctrl+C para detener.");
process.on("SIGINT", () => {
  sim.stop();
  process.exit(0);
});
