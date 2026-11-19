/**
 * dev/smoke.ts — Prueba de humo de punta a punta.   npm run smoke
 *
 * Requisitos: base de datos arriba, `npm run db:seed` hecho y el servidor corriendo
 * (`npm run dev` en otra terminal). Esta prueba arranca su propio robot simulado.
 *
 * Revisa: login, renovación de token, robots, sensores y umbrales, WebSocket de la web
 * (telemetría con niveles, status, video, alertas, ping/pong, hablar al robot).
 */
import WebSocket from "ws";
import { requiredEnv } from "../env";
import { startSimulator } from "../simulator/sim";

const API = process.env.SMOKE_API_URL ?? "http://localhost:4000";
const WS_WEB = API.replace(/^http/, "ws") + "/ws/web";
const WS_ROBOT = API.replace(/^http/, "ws") + "/ws/robot";
const ROBOT_ID = process.env.SIM_ROBOT_ID ?? "delta-force";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ✔" : "  ✘"} ${name}${!ok && detail ? `  -> ${detail}` : ""}`);
  if (!ok) failures++;
}

type Json = Record<string, any>;

async function http(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Json };
}

/** Cliente WebSocket de la web con una bandeja de mensajes para esperar lo que llegue. */
class WebClientProbe {
  ws: WebSocket;
  json: Json[] = [];
  binary: Buffer[] = [];
  closed: number | null = null;
  constructor() {
    this.ws = new WebSocket(WS_WEB);
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) this.binary.push(data as Buffer);
      else this.json.push(JSON.parse(data.toString()) as Json);
    });
    this.ws.on("close", (code) => (this.closed = code));
  }
  open() {
    return new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }
  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }
  async waitFor(predicate: (msg: Json) => boolean, timeoutMs = 5000): Promise<Json | undefined> {
    const end = Date.now() + timeoutMs;
    let from = 0;
    while (Date.now() < end) {
      for (; from < this.json.length; from++) {
        if (predicate(this.json[from]!)) return this.json[from];
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  }
  async waitBinary(timeoutMs = 4000): Promise<Buffer | undefined> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.binary.length) return this.binary[0];
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  }
}

async function main() {
  const email = process.env.SMOKE_EMAIL ?? requiredEnv("SEED_OPERATOR_EMAIL");
  const password = process.env.SMOKE_PASSWORD ?? requiredEnv("SEED_OPERATOR_PASSWORD");

  console.log("\nREST");
  const health = await http("GET", "/health");
  check("el servidor responde", health.status === 200, `status ${health.status}`);

  const bad = await http("POST", "/api/auth/login", { email, password: "incorrecta-123" });
  check("login con contraseña mala -> 401 invalid_credentials", bad.status === 401 && bad.json.error?.code === "invalid_credentials");

  const unknown = await http("POST", "/api/auth/login", { email: "nadie@ares.local", password: "loquesea123" });
  check("login con correo inexistente -> mismo 401", unknown.status === 401 && unknown.json.error?.message === bad.json.error?.message);

  const login = await http("POST", "/api/auth/login", { email, password });
  check("login correcto devuelve tokens y usuario", login.status === 200 && !!login.json.accessToken && !!login.json.refreshToken && !!login.json.user?.name);
  const { accessToken, refreshToken } = login.json as { accessToken: string; refreshToken: string };

  const noAuth = await http("GET", "/api/robots");
  check("GET /api/robots sin token -> 401", noAuth.status === 401);

  const robots = await http("GET", "/api/robots", undefined, accessToken);
  const delta = (robots.json.robots as Json[] | undefined)?.find((r) => r.robotId === ROBOT_ID);
  check("GET /api/robots incluye delta-force", robots.status === 200 && !!delta);

  const missing = await http("GET", "/api/robots/no-existe", undefined, accessToken);
  check("robot inexistente -> 404 robot_not_found", missing.status === 404 && missing.json.error?.code === "robot_not_found");

  const sensors = await http("GET", `/api/robots/${ROBOT_ID}/sensors`, undefined, accessToken);
  const list = (sensors.json.sensors ?? []) as Json[];
  check("GET sensors devuelve los 5 sensores", list.length === 5);
  const mq2b = list.find((s) => s.sensor === "mq2-b")!;

  const invalid = await http("PUT", `/api/robots/${ROBOT_ID}/sensors/mq2-b/thresholds`, { warn: 700, crit: 300, direction: "above" }, accessToken);
  check("umbrales incoherentes -> 400 invalid_thresholds", invalid.status === 400 && invalid.json.error?.code === "invalid_thresholds");

  const put = await http("PUT", `/api/robots/${ROBOT_ID}/sensors/mq2-b/thresholds`, { warn: 310, crit: 610, direction: "above" }, accessToken);
  check("umbrales válidos -> 200", put.status === 200 && put.json.warn === 310 && put.json.crit === 610);
  const restore = await http("PUT", `/api/robots/${ROBOT_ID}/sensors/mq2-b/thresholds`, { warn: mq2b.warn, crit: mq2b.crit, direction: mq2b.direction }, accessToken);
  check("umbrales restaurados", restore.status === 200 && restore.json.warn === mq2b.warn);

  const refreshed = await http("POST", "/api/auth/refresh", { refreshToken });
  check("refresh entrega tokens nuevos", refreshed.status === 200 && !!refreshed.json.accessToken && refreshed.json.refreshToken !== refreshToken);
  const reused = await http("POST", "/api/auth/refresh", { refreshToken });
  check("reusar un refresh token ya usado -> 401", reused.status === 401);

  console.log("\nRobot simulado + WebSocket de la web");
  const sim = startSimulator({ url: WS_ROBOT, robotId: ROBOT_ID, token: requiredEnv("SIM_ROBOT_TOKEN"), gasPeriodS: 10, log: () => {} });
  await new Promise((r) => setTimeout(r, 1500)); // deja que el robot se conecte

  const noAuthWs = new WebClientProbe();
  await noAuthWs.open();
  noAuthWs.send({ type: "subscribe", v: 1, robotId: ROBOT_ID, streams: ["telemetry"] });
  await new Promise((r) => setTimeout(r, 500));
  check("subscribe sin auth previa -> cierre 4401", noAuthWs.closed === 4401, `cierre ${noAuthWs.closed}`);

  const badTokenWs = new WebClientProbe();
  await badTokenWs.open();
  badTokenWs.send({ type: "auth", v: 1, token: "token.falso.xyz" });
  await new Promise((r) => setTimeout(r, 500));
  check("auth con token falso -> cierre 4401", badTokenWs.closed === 4401, `cierre ${badTokenWs.closed}`);

  const web = new WebClientProbe();
  await web.open();
  web.send({ type: "auth", v: 1, token: refreshed.json.accessToken });
  const ready = await web.waitFor((m) => m.type === "ready");
  check("auth válida -> ready con el usuario", ready?.user?.name === login.json.user.name);
  const presence = await web.waitFor((m) => m.type === "presence" && m.robotId === ROBOT_ID && m.online === true, 2000);
  check("recibe presencia de los robots conectados", !!presence);

  web.send({ type: "subscribe", v: 1, robotId: ROBOT_ID, streams: ["telemetry", "status", "video"] });
  const subscribed = await web.waitFor((m) => m.type === "subscribed");
  check("subscribed indica placas data y cam en línea", subscribed?.online?.data === true && subscribed?.online?.cam === true, JSON.stringify(subscribed?.online));

  const telemetry = await web.waitFor((m) => m.type === "telemetry", 4000);
  const first = telemetry?.readings?.[0];
  check("telemetría con ts, robotId y nivel por lectura", telemetry?.robotId === ROBOT_ID && typeof telemetry?.ts === "number" && typeof first?.level === "string");
  check("telemetría trae las 7 lecturas (DHT11 con humedad)", telemetry?.readings?.length === 7);

  const status = await web.waitFor((m) => m.type === "status", 5000);
  check("status con batería y GPS", typeof status?.battery?.percent === "number" && typeof status?.gps?.lat === "number");

  const frame = await web.waitBinary(5000);
  check("video: llega un frame 0x03 con JPEG (FF D8)", !!frame && frame[0] === 0x03 && frame[3] === 0xff && frame[4] === 0xd8);

  const t0 = Date.now();
  web.send({ type: "ping", v: 1, t: t0 });
  const pong = await web.waitFor((m) => m.type === "pong");
  check("ping -> pong con el mismo t", pong?.t === t0);

  const alert = await web.waitFor((m) => m.type === "alert" && m.state === "open", 16000);
  check("el gas sube y el servidor emite una alerta abierta", !!alert && alert.robotId === ROBOT_ID && alert.sensor === "mq2-b", JSON.stringify(alert));
  const cleared = await web.waitFor((m) => m.type === "alert" && m.state === "cleared" && m.id === alert?.id, 16000);
  check("al bajar el gas la alerta se cierra con el mismo id", !!cleared);

  console.log("\nVoz (PTT)");
  web.send({ type: "ptt.start", v: 1 });
  const granted = await web.waitFor((m) => m.type === "ptt.granted");
  check("ptt.start -> ptt.granted", !!granted);

  const other = new WebClientProbe();
  await other.open();
  other.send({ type: "auth", v: 1, token: refreshed.json.accessToken });
  await other.waitFor((m) => m.type === "ready");
  other.send({ type: "subscribe", v: 1, robotId: ROBOT_ID, streams: ["telemetry"] });
  await other.waitFor((m) => m.type === "subscribed");
  other.send({ type: "ptt.start", v: 1 });
  const busy = await other.waitFor((m) => m.type === "ptt.denied");
  check("segundo operador -> ptt.denied (busy)", busy?.reason === "busy");

  const voice = Buffer.alloc(3 + 1280);
  voice[0] = 0x02;
  for (let i = 0; i < 5; i++) web.ws.send(voice, { binary: true });
  await new Promise((r) => setTimeout(r, 600));
  check("la voz del operador llega a la placa de datos", sim.voiceFrames() === 5, `llegaron ${sim.voiceFrames()}`);

  web.send({ type: "ptt.stop", v: 1 });
  await new Promise((r) => setTimeout(r, 300));
  other.send({ type: "ptt.start", v: 1 });
  const nowGranted = await other.waitFor((m) => m.type === "ptt.granted", 2000);
  check("tras ptt.stop el turno queda libre", !!nowGranted);

  web.send({ type: "unsubscribe", v: 1 });
  other.ws.close();
  web.ws.close();
  sim.stop();
  await new Promise((r) => setTimeout(r, 300));

  console.log(failures === 0 ? "\n✔ TODO BIEN\n" : `\n✘ ${failures} prueba(s) fallaron\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\n✘ La prueba se detuvo:", error instanceof Error ? error.message : error);
  console.error("  ¿Está corriendo el servidor (npm run dev) y hiciste npm run db:seed?\n");
  process.exit(1);
});
