import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, createUser } from "../backend/src/database.js";
import { createBackup } from "../scripts/backup.js";
test("backup online inclui dados do WAL, é restaurável e não sobrescreve banco ou backup existente", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monitor-backup-")),
    source = join(dir, "source.sqlite"),
    target = join(dir, "backup.sqlite");
  const db = openDatabase(source);
  try {
    createUser(db, {
      name: "Professor",
      email: "backup@test.local",
      password: "Backup-test-123!",
      role: "PROFESSOR",
    });
    await createBackup(source, target);
    const restored = openDatabase(target);
    try {
      assert.equal(
        restored.prepare("SELECT email FROM users").get().email,
        "backup@test.local",
      );
      assert.equal(
        restored.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok",
      );
    } finally {
      restored.close();
    }
    if (process.platform !== "win32")
      assert.equal(statSync(target).mode & 0o777, 0o600);
    await assert.rejects(createBackup(source, target), /já existe/);
    await assert.rejects(createBackup(source, source), /banco ativo/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
