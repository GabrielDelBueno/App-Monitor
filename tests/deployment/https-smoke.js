// Run after: docker build -t app-monitor:production .
// This checks a local HTTPS deployment, not public DNS or ACME issuance.
import { spawnSync } from "node:child_process";
import { request, Agent } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
const suffix = randomBytes(5).toString("hex"),
  network = `monitor-tls-${suffix}`,
  app = `monitor-app-${suffix}`,
  caddy = `monitor-caddy-${suffix}`,
  volume = `monitor-data-${suffix}`,
  tmp = mkdtempSync(join(tmpdir(), "monitor-tls-"));
const password = randomBytes(24).toString("hex");
function docker(args, { env = process.env, ignore = false } = {}) {
  const r = spawnSync("docker", args, { env, encoding: "utf8" });
  if (r.status !== 0 && !ignore) throw Error(r.stderr);
  return r.stdout.trim();
}
function https(path, { method = "GET", body, cookie, ca } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: 8443,
        servername: "localhost",
        path,
        method,
        ca,
        agent: new Agent({ ca, proxyEnv: {} }),
        headers: {
          Host: "localhost:8443",
          ...(body
            ? {
                "Content-Type": "application/json",
                Origin: "https://localhost:8443",
              }
            : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (b) => (text += b));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: JSON.parse(text),
            });
          } catch {
            reject(Error(`Resposta HTTPS não JSON: status ${res.statusCode}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
try {
  docker(["network", "create", network]);
  docker(["volume", "create", volume]);
  docker([
    "run",
    "-d",
    "--name",
    app,
    "--network",
    network,
    "--network-alias",
    "app",
    "--mount",
    `source=${volume},target=/app/data`,
    "-e",
    "PUBLIC_BASE_URL=https://localhost:8443",
    "-e",
    "TRUST_PROXY=1",
    "app-monitor:production",
  ]);
  docker(
    [
      "exec",
      "-e",
      "ADMIN_EMAIL",
      "-e",
      "ADMIN_NAME",
      "-e",
      "ADMIN_PASSWORD",
      app,
      "npm",
      "run",
      "bootstrap",
    ],
    {
      env: {
        ...process.env,
        ADMIN_EMAIL: "admin@tls-test.local",
        ADMIN_NAME: "TLS Test",
        ADMIN_PASSWORD: password,
      },
    },
  );
  docker([
    "create",
    "--name",
    caddy,
    "--network",
    network,
    "-p",
    "127.0.0.1:8443:443",
    "-e",
    "APP_DOMAIN=localhost",
    "-e",
    "ACME_EMAIL=test@example.com",
    "-e",
    "NO_PROXY=app,localhost,127.0.0.1",
    "-e",
    "no_proxy=app,localhost,127.0.0.1",
    "caddy:2-alpine",
  ]);
  docker(["cp", "deploy/Caddyfile", `${caddy}:/etc/caddy/Caddyfile`]);
  docker(["start", caddy]);
  const root = join(tmp, "root.crt");
  let ready = false;
  for (let i = 0; i < 50; i++) {
    const r = spawnSync(
      "docker",
      ["cp", `${caddy}:/data/caddy/pki/authorities/local/root.crt`, root],
      { encoding: "utf8" },
    );
    if (r.status === 0) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw Error("Caddy não produziu a CA local de teste.");
  const ca = readFileSync(root);
  const health = await https("/health", { ca });
  assert.equal(health.status, 200);
  assert.equal(health.body.database, "ok");
  assert.match(health.headers["strict-transport-security"], /31536000/);
  const login = await https("/api/login", {
    ca,
    method: "POST",
    body: { email: "admin@tls-test.local", password },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"][0];
  assert.match(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
  const me = await https("/api/me", { ca, cookie: cookie.split(";")[0] });
  assert.equal(me.status, 200);
  assert.equal(me.body.role, "ADMINISTRADOR");
  docker([
    "exec",
    app,
    "npm",
    "run",
    "backup",
    "--",
    "/app/backups/smoke.sqlite",
  ]);
  const integrity = docker([
    "exec",
    app,
    "node",
    "--input-type=module",
    "-e",
    "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/app/backups/smoke.sqlite',{readOnly:true});if(db.prepare('SELECT COUNT(*) AS n FROM users').get().n!==1)process.exit(1);db.close();",
  ]);
  void integrity;
  console.log(
    "HTTPS local: certificado verificado com CA explícita, proxy, cookie Secure, login, API e backup passaram.",
  );
} finally {
  docker(["rm", "-f", caddy, app], { ignore: true });
  docker(["volume", "rm", volume], { ignore: true });
  docker(["network", "rm", network], { ignore: true });
  rmSync(tmp, { recursive: true, force: true });
}
