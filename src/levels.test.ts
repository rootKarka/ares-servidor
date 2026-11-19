import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateLevel, rawLevel, validThresholds } from "./levels";

const gas = { direction: "above", warn: 300, crit: 600 } as const;
const distance = { direction: "below", warn: 50, crit: 20 } as const;

test("rawLevel: gas (por encima)", () => {
  assert.equal(rawLevel(100, gas), "normal");
  assert.equal(rawLevel(300, gas), "warning");
  assert.equal(rawLevel(599, gas), "warning");
  assert.equal(rawLevel(600, gas), "critical");
});

test("rawLevel: distancia (por debajo)", () => {
  assert.equal(rawLevel(200, distance), "normal");
  assert.equal(rawLevel(50, distance), "warning");
  assert.equal(rawLevel(20, distance), "critical");
});

test("histéresis: no baja de crítico justo bajo el umbral", () => {
  assert.equal(evaluateLevel(580, gas, "critical"), "critical"); // 580 >= 570
  assert.equal(evaluateLevel(560, gas, "critical"), "warning");
});

test("histéresis: no baja de advertencia justo bajo el umbral", () => {
  assert.equal(evaluateLevel(290, gas, "warning"), "warning"); // 290 >= 285
  assert.equal(evaluateLevel(280, gas, "warning"), "normal");
});

test("histéresis en distancia (por debajo)", () => {
  assert.equal(evaluateLevel(21, distance, "critical"), "critical"); // 21 <= 21
  assert.equal(evaluateLevel(25, distance, "critical"), "warning");
});

test("empeorar es inmediato", () => {
  assert.equal(evaluateLevel(650, gas, "normal"), "critical");
  assert.equal(evaluateLevel(310, gas, "normal"), "warning");
});

test("sin nivel previo se usa el nivel directo", () => {
  assert.equal(evaluateLevel(700, gas), "critical");
});

test("validThresholds", () => {
  assert.equal(validThresholds(gas), true);
  assert.equal(validThresholds({ direction: "above", warn: 600, crit: 300 }), false);
  assert.equal(validThresholds(distance), true);
  assert.equal(validThresholds({ direction: "below", warn: 10, crit: 20 }), false);
  assert.equal(validThresholds({ direction: "above", warn: Number.NaN, crit: 1 }), false);
});
