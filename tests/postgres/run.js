import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const name = `monitor-pg-test-${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const dir = mkdtempSync(join(tmpdir(), "monitor-pg-"));
function docker(args) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0)
    throw Error("Falha ao executar Docker para o teste PostgreSQL.");
  return r.stdout.trim();
}
let started = false;
try {
  const envFile = join(dir, "db.env");
  writeFileSync(
    envFile,
    `POSTGRES_PASSWORD=${password}\nPOSTGRES_USER=monitor\nPOSTGRES_DB=monitor\n`,
    { mode: 0o600 },
  );
  const cert = join(dir, "server.crt"),
    key = join(dir, "server.key");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  if (generated.status !== 0)
    throw Error("Não foi possível criar a CA de teste com OpenSSL.");
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--env-file",
    envFile,
    "-p",
    "127.0.0.1::5432",
    "--volume",
    `${dir}:/fixture:ro`,
    "--entrypoint",
    "sh",
    "postgres:17-alpine",
    "-c",
    "mkdir -p /certs && cp /fixture/server.key /fixture/server.crt /certs/ && chown -R postgres:postgres /certs && chmod 600 /certs/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key",
  ]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const check = spawnSync(
      "docker",
      [
        "exec",
        name,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "monitor",
        "-d",
        "monitor",
      ],
      { stdio: "ignore" },
    );
    if (check.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw Error("PostgreSQL não ficou pronto.");
  const port = docker(["port", name, "5432/tcp"]).split(":").at(-1);
  const url = `postgresql://monitor:${password}@127.0.0.1:${port}/monitor`;
  const child = spawn(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "tests/workflow.test.js",
      "tests/postgres/persistence.js",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        TEST_DATABASE_URL: url,
        TEST_DATABASE_TLS: "true",
        NODE_EXTRA_CA_CERTS: cert,
      },
    },
  );
  process.exitCode = await new Promise((resolve) =>
    child.once("exit", (code) => resolve(code ?? 1)),
  );
} finally {
  if (started) docker(["rm", "-f", "-v", name]);
  rmSync(dir, { recursive: true, force: true });
}
