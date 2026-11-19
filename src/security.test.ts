import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, safeEqualHex, sha256, verifyPassword } from "./security";

test("hashPassword / verifyPassword", async () => {
  const hash = await hashPassword("clave-segura-123");
  assert.ok(hash.startsWith("scrypt$"));
  assert.equal(await verifyPassword("clave-segura-123", hash), true);
  assert.equal(await verifyPassword("otra-clave", hash), false);
  assert.equal(await verifyPassword("x", "formato-invalido"), false);
});

test("cada hash lleva su propia sal", async () => {
  assert.notEqual(await hashPassword("igual"), await hashPassword("igual"));
});

test("sha256 y safeEqualHex", () => {
  assert.equal(safeEqualHex(sha256("a"), sha256("a")), true);
  assert.equal(safeEqualHex(sha256("a"), sha256("b")), false);
  assert.equal(safeEqualHex("abcd", "ab"), false);
});
