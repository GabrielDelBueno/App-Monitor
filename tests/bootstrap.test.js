import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { openDatabase, verifyPassword } from "../backend/src/database.js";
test("bootstrap cria uma conta com senha própria e não sobrescreve administrador", () => {
  const dir = mkdtempSync(join(tmpdir(), "monitor-bootstrap-"));
  const path = join(dir, "db.sqlite");
  const password = randomBytes(24).toString("hex");
  const env = {
    ...process.env,
    DATABASE_PATH: path,
    ADMIN_NAME: "Administrador",
    ADMIN_EMAIL: "admin@bootstrap.local",
    ADMIN_PASSWORD: password,
  };
  try {
    const first = spawnSync(process.execPath, ["backend/src/bootstrap.js"], {
      env,
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    const db = openDatabase(path);
    const user = db.prepare("SELECT * FROM users").get();
    assert.equal(user.role, "ADMINISTRADOR");
    assert.ok(verifyPassword(password, user.password));
    db.close();
    const second = spawnSync(process.execPath, ["backend/src/bootstrap.js"], {
      env,
      encoding: "utf8",
    });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /Já existe um administrador/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
