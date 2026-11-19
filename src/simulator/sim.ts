/**
 * simulator/sim.ts — Robot simulado.
 *
 * Se conecta a /ws/robot exactamente como lo harán las ESP32 y respeta el contrato:
 *   - placa "data": hello, telemetría (1 s), status (2 s), micrófono (0x01) bajo demanda,
 *     y recibe la voz del operador (0x02).
 *   - placa "cam": hello y video (0x03) bajo demanda.
 * Sirve para desarrollar y probar toda la web SIN el robot real.
 *
 * El gas del sensor B sube y baja en ciclos para cruzar los umbrales (advertencia a 300 ppm,
 * crítico a 600 ppm) y así disparar alertas.
 */
import WebSocket from "ws";
import type { Device } from "../contract";
import { TEST_JPEG } from "./testFrame";

export interface SimOptions {
  url: string;
  robotId: string;
  token: string;
  /** Simular también la ESP32-CAM (por defecto sí). */
  cam?: boolean;
  /** Duración de un ciclo de subida/bajada del gas, en segundos (por defecto 60). */
  gasPeriodS?: number;
  log?: (message: string) => void;
}

export interface SimHandle {
  stop(): void;
  /** Cuántos frames de voz del operador (0x02) llegaron a la placa de datos. */
  voiceFrames(): number;
}

const AUDIO_SAMPLES = 640; // 40 ms a 16 kHz
const rnd = (min: number, max: number) => min + Math.random() * (max - min);
const round = (value: number, decimals = 1) => Number(value.toFixed(decimals));

export function startSimulator(options: SimOptions): SimHandle {
  const log = options.log ?? ((message: string) => console.log(`[sim] ${message}`));
  const gasPeriodMs = (options.gasPeriodS ?? 60) * 1000;
  const startedAt = Date.now();
  let stopped = false;
  let voiceFrames = 0;
  let battery = 84;
  let distance = 150;
  let lat = -12.0464;
  let lon = -77.0428;
  const sockets = new Set<WebSocket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function readings() {
    const t = Date.now() - startedAt;
    // Sensor B: sube y baja entre ~50 y ~750 ppm; el A se queda tranquilo.
    const gasB = 400 + 350 * Math.sin((2 * Math.PI * t) / gasPeriodMs - Math.PI / 2);
    distance = Math.min(300, Math.max(8, distance + rnd(-12, 12)));
    return [
      { sensor: "mq2-a", kind: "gas", value: Math.round(rnd(205, 235)), unit: "ppm" },
      { sensor: "mq2-b", kind: "gas", value: Math.round(gasB + rnd(-8, 8)), unit: "ppm" },
      { sensor: "hcsr04-a", kind: "distance", value: Math.round(distance), unit: "cm" },
      { sensor: "dht11-a", kind: "temperature", value: round(24.8 + rnd(-0.4, 0.4)), unit: "C" },
      { sensor: "dht11-a", kind: "humidity", value: Math.round(rnd(56, 60)), unit: "%" },
      { sensor: "dht11-b", kind: "temperature", value: round(28.3 + rnd(-0.4, 0.4)), unit: "C" },
      { sensor: "dht11-b", kind: "humidity", value: Math.round(rnd(62, 66)), unit: "%" },
    ];
  }

  function status() {
    battery = Math.max(5, battery - 1 / 60); // ~1 % por minuto
    lat += rnd(-0.00002, 0.00003);
    lon += rnd(-0.00002, 0.00003);
    return {
      battery: { percent: Math.round(battery), voltage: round(10.2 + battery * 0.026, 2) },
      net: { rssi: Math.round(rnd(-66, -58)) },
      gps: { lat: round(lat, 6), lon: round(lon, 6), sats: 7, fix: true },
      imu: { pitch: round(rnd(5, 8)), roll: round(rnd(-1.5, 1.5)) },
      mode: "manual",
      speed: 0.4,
      uptimeMs: Date.now() - startedAt,
    };
  }

  function runDevice(device: Device): void {
    if (stopped) return;
    const ws = new WebSocket(options.url);
    sockets.add(ws);
    const intervals: ReturnType<typeof setInterval>[] = [];
    let micTimer: ReturnType<typeof setInterval> | null = null;
    let videoTimer: ReturnType<typeof setInterval> | null = null;
    let seq = 0;
    let phase = 0;

    const sendJson = (msg: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    const sendBinary = (type: number, payload: Buffer) => {
      if (ws.readyState !== ws.OPEN) return;
      const frame = Buffer.alloc(3 + payload.length);
      frame[0] = type;
      frame.writeUInt16LE(seq++ & 0xffff, 1);
      payload.copy(frame, 3);
      ws.send(frame, { binary: true });
    };

    const stopMedia = () => {
      if (micTimer) clearInterval(micTimer);
      if (videoTimer) clearInterval(videoTimer);
      micTimer = videoTimer = null;
    };

    ws.on("open", () => {
      sendJson({ type: "hello", v: 1, robotId: options.robotId, device, token: options.token, fw: "sim-0.1.0" });
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if ((data as Buffer)[0] === 0x02) voiceFrames++;
        return;
      }
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      switch (msg.type) {
        case "welcome": {
          log(`${device}: conectada a ${options.url}`);
          if (device === "data") {
            const telemetryEvery = Number(msg.telemetryEveryMs) || 1000;
            const statusEvery = Number(msg.statusEveryMs) || 2000;
            intervals.push(setInterval(() => sendJson({ type: "telemetry", v: 1, readings: readings() }), telemetryEvery));
            intervals.push(setInterval(() => sendJson({ type: "status", v: 1, ...status() }), statusEvery));
          }
          break;
        }
        case "cmd": {
          const name = String(msg.name);
          const args = (msg.args ?? {}) as { fps?: number };
          let ok = true;
          if (name === "video.start" && device === "cam") {
            stopMedia();
            videoTimer = setInterval(() => sendBinary(0x03, TEST_JPEG), 1000 / (args.fps || 8));
            log("cam: video.start");
          } else if (name === "video.stop" && device === "cam") {
            stopMedia();
            log("cam: video.stop");
          } else if (name === "audio.listen.start" && device === "data") {
            stopMedia();
            micTimer = setInterval(() => {
              // Tono de 440 Hz, PCM 16 bits little-endian, 16 kHz, 40 ms por frame.
              const pcm = Buffer.alloc(AUDIO_SAMPLES * 2);
              for (let i = 0; i < AUDIO_SAMPLES; i++) {
                pcm.writeInt16LE(Math.round(8000 * Math.sin(phase)), i * 2);
                phase += (2 * Math.PI * 440) / 16000;
              }
              sendBinary(0x01, pcm);
            }, 40);
            log("data: audio.listen.start");
          } else if (name === "audio.listen.stop" && device === "data") {
            stopMedia();
            log("data: audio.listen.stop");
          } else if (name === "audio.speak.start" || name === "audio.speak.stop") {
            log(`data: ${name}`);
          } else {
            ok = false;
          }
          sendJson({ type: "ack", v: 1, id: msg.id, ok, ...(ok ? {} : { error: "unknown_cmd" }) });
          break;
        }
        case "error":
          log(`${device}: el servidor respondió error ${String(msg.code)}`);
          break;
        default:
          break;
      }
    });

    ws.on("close", (code) => {
      intervals.forEach(clearInterval);
      stopMedia();
      sockets.delete(ws);
      if (stopped) return;
      if (code === 4401) {
        log(`${device}: token rechazado (4401). Revisa SIM_ROBOT_TOKEN. Reintento en 5 s.`);
      } else if (code === 4409) {
        return; // otra conexión de la misma placa tomó el lugar: no competir con ella
      }
      const retry = setTimeout(() => runDevice(device), code === 4401 ? 5000 : 3000);
      timers.add(retry);
    });
    ws.on("error", () => {
      /* se gestiona en close */
    });
  }

  runDevice("data");
  if (options.cam !== false) runDevice("cam");

  return {
    stop() {
      stopped = true;
      timers.forEach(clearTimeout);
      sockets.forEach((ws) => ws.close(1000));
    },
    voiceFrames: () => voiceFrames,
  };
}
