/**
 * levels.ts — Cálculo del nivel de un sensor (normal / advertencia / crítico).
 *
 * Con histéresis: una vez que un sensor entra en advertencia o crítico, solo "mejora"
 * cuando se aleja del umbral un 5 %. Así un valor que oscila justo en el límite no
 * genera decenas de alertas por minuto.
 */
import type { Level, SensorConfig } from "./contract";

export type EvaluatedLevel = "normal" | "warning" | "critical";
export type Thresholds = Pick<SensorConfig, "direction" | "warn" | "crit">;

export const HYSTERESIS = 0.05;

const SEVERITY: Record<EvaluatedLevel, number> = { normal: 0, warning: 1, critical: 2 };

/** Nivel "a secas", sin histéresis. "above": gas, temperatura. "below": distancia. */
export function rawLevel(value: number, t: Thresholds): EvaluatedLevel {
  if (t.direction === "above") {
    if (value >= t.crit) return "critical";
    if (value >= t.warn) return "warning";
    return "normal";
  }
  if (value <= t.crit) return "critical";
  if (value <= t.warn) return "warning";
  return "normal";
}

export function evaluateLevel(value: number, t: Thresholds, previous?: Level): EvaluatedLevel {
  const raw = rawLevel(value, t);
  if (!previous || previous === "offline") return raw;
  if (SEVERITY[raw] >= SEVERITY[previous]) return raw; // empeora o se mantiene: sin margen

  // Mejora: los umbrales se corren un 5 % hacia el lado "seguro" para exigir más margen.
  const shift = t.direction === "above" ? -1 : 1;
  const relaxed: Thresholds = {
    direction: t.direction,
    warn: t.warn + shift * Math.abs(t.warn) * HYSTERESIS,
    crit: t.crit + shift * Math.abs(t.crit) * HYSTERESIS,
  };
  const held = rawLevel(value, relaxed);
  return SEVERITY[held] < SEVERITY[previous] ? held : previous;
}

/** Valida umbrales: "above" exige warn < crit; "below" exige warn > crit. */
export function validThresholds(t: Thresholds): boolean {
  if (!Number.isFinite(t.warn) || !Number.isFinite(t.crit)) return false;
  return t.direction === "above" ? t.warn < t.crit : t.warn > t.crit;
}
