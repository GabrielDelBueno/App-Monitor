import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import * as oidc from "openid-client";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createHash } from "node:crypto";
import { createApp } from "../backend/src/server.js";
import { createUser } from "../backend/src/database.js";
import { govbrFromEnvironment } from "../backend/src/govbr.js";
let provider,
  server,
  db,
  base,
  issuer,
  keys,
  wrongKeys,
  professor,
  admin,
  settings;
const codes = new Map(),
  password = "Mock-Account-123!",
  clientId = "test-client",
  secret = "mock-client-secret";
const hash = (v) => createHash("sha256").update(v).digest("base64url");
function browser() {
  const jar = new Map();
  return {
    async request(path, method = "GET", body) {
      const r = await fetch(new URL(path, base), {
        method,
        redirect: "manual",
        headers: {
          Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const value of r.headers.getSetCookie()) {
        const [pair] = value.split(";"),
          i = pair.indexOf("=");
        const key = pair.slice(0, i);
        if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(value)) jar.delete(key);
        else jar.set(key, pair.slice(i + 1));
      }
      return r;
    },
    jar,
  };
}
async function login(browser, email) {
  assert.equal(
    (await browser.request("/api/login", "POST", { email, password })).status,
    200,
  );
}
async function flow(browser, mode = "login") {
  const r = await browser.request(
    mode === "link" ? "/auth/govbr/link" : "/auth/govbr",
  );
  assert.equal(r.status, 303);
  const url = new URL(r.headers.get("location"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("nonce"));
  assert.equal(url.searchParams.get("response_type"), "code");
  return url;
}
async function callback(browser, url, overrides = {}) {
  const code = `code-${codes.size}`;
  codes.set(code, {
    nonce: url.searchParams.get("nonce"),
    challenge: url.searchParams.get("code_challenge"),
    sub: "12345678901",
    ...overrides,
  });
  return browser.request(
    `/auth/govbr/callback?code=${code}&state=${encodeURIComponent(url.searchParams.get("state"))}`,
  );
}
before(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  wrongKeys = await generateKeyPair("RS256");
  const p = express();
  p.use(express.urlencoded({ extended: false }));
  p.get("/jwk", async (_req, res) =>
    res.json({
      keys: [
        {
          ...(await exportJWK(keys.publicKey)),
          kid: "mock-key",
          alg: "RS256",
          use: "sig",
        },
      ],
    }),
  );
  p.post("/token", async (req, res) => {
    const credentials = Buffer.from(
      req.headers.authorization?.split(" ")[1] || "",
      "base64",
    )
      .toString()
      .split(":")
      .map((v) => decodeURIComponent(v.replace(/\+/g, " ")));
    if (credentials[0] !== clientId || credentials[1] !== secret)
      return res.status(401).json({ error: "invalid_client" });
    const payload = codes.get(req.body.code);
    if (
      !payload ||
      payload.consumed ||
      hash(req.body.code_verifier) !== payload.challenge
    )
      return res.status(400).json({ error: "invalid_grant" });
    payload.consumed = true;
    const jwt = await new SignJWT({
      nonce: payload.nonce,
      email: "admin@mock.local",
    })
      .setProtectedHeader({ alg: "RS256", kid: "mock-key" })
      .setIssuer(payload.issuer || issuer)
      .setAudience(payload.audience || clientId)
      .setSubject(payload.sub)
      .setIssuedAt()
      .setExpirationTime(
        payload.expired ? Math.floor(Date.now() / 1000) - 120 : "5m",
      )
      .sign(payload.badSignature ? wrongKeys.privateKey : keys.privateKey);
    res.json({
      access_token: "mock-access-token",
      token_type: "Bearer",
      expires_in: 300,
      id_token: jwt,
    });
  });
  provider = p.listen(0, "127.0.0.1");
  await new Promise((r) => provider.once("listening", r));
  issuer = `http://127.0.0.1:${provider.address().port}`;
  const config = new oidc.Configuration(
    {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwk`,
      response_types_supported: ["code"],
      id_token_signing_alg_values_supported: ["RS256"],
    },
    clientId,
    { client_secret: secret, id_token_signed_response_alg: "RS256" },
    oidc.ClientSecretBasic(secret),
  );
  oidc.allowInsecureRequests(config); // HTTP exists only inside this isolated mock test.
  oidc.enableNonRepudiationChecks(config);
  settings = {
    environment: "homologacao",
    subjectKey: "test-only-subject-key-with-more-than-32-characters",
    configuration: async () => config,
  };
  const instance = createApp({ databasePath: ":memory:", govbr: settings });
  db = instance.db;
  professor = createUser(db, {
    name: "Professor autorizado",
    email: "prof@mock.local",
    role: "PROFESSOR",
    password,
  });
  admin = createUser(db, {
    name: "Administrador",
    email: "admin@mock.local",
    role: "ADMINISTRADOR",
    password,
  });
  server = instance.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  settings.baseUrl = base;
});
after(async () => {
  await Promise.all([
    new Promise((r) => server.close(r)),
    new Promise((r) => provider.close(r)),
  ]);
  db.close();
});
test("GOV.BR permanece desabilitado sem configuração; produção não aceita HTTP ou configuração incompleta", () => {
  assert.equal(govbrFromEnvironment({}), null);
  assert.throws(() =>
    govbrFromEnvironment({
      GOVBR_ENABLED: "true",
      GOVBR_ENVIRONMENT: "invalid",
    }),
  );
  assert.throws(() =>
    govbrFromEnvironment({
      GOVBR_ENABLED: "true",
      GOVBR_ENVIRONMENT: "homologacao",
      PUBLIC_BASE_URL: "http://school.example",
    }),
  );
  assert.throws(() =>
    govbrFromEnvironment({
      GOVBR_ENABLED: "true",
      GOVBR_ENVIRONMENT: "homologacao",
      PUBLIC_BASE_URL: "https://school.example",
      COOKIE_SECURE: "true",
    }),
  );
});
test("início usa PKCE, nonce e cookie HttpOnly/Lax; callback sem navegador, com state adulterado ou expirado é rejeitado", async () => {
  const b = browser(),
    r = await b.request("/auth/govbr");
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  assert.match(r.headers.get("set-cookie"), /SameSite=Lax/);
  const url = new URL(r.headers.get("location"));
  const attacker = browser();
  assert.match(
    (await callback(attacker, url)).headers.get("location"),
    /govbr_invalid_flow/,
  );
  assert.match(
    (
      await b.request("/auth/govbr/callback?state=forged&code=forged")
    ).headers.get("location"),
    /govbr_invalid_flow/,
  );
  db.prepare("UPDATE oauth_flows SET expires_at=0").run();
  assert.match(
    (await callback(b, url)).headers.get("location"),
    /govbr_invalid_flow/,
  );
});
test("identidade não vinculada não cria usuário nem entra por coincidência de e-mail", async () => {
  const b = browser();
  const r = await callback(b, await flow(b));
  assert.match(r.headers.get("location"), /govbr_not_linked/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 2);
  assert.equal((await b.request("/api/me")).status, 401);
});
test("vínculo exige conta de professor autenticada; registra identidade pseudonimizada e permite entrada posterior", async () => {
  assert.equal((await browser().request("/auth/govbr/link")).status, 403);
  const staff = browser();
  await login(staff, "admin@mock.local");
  assert.equal((await staff.request("/auth/govbr/link")).status, 403);
  const b = browser();
  await login(b, "prof@mock.local");
  const start = await flow(b, "link");
  const linked = await callback(b, start);
  assert.equal(linked.headers.get("location"), "/?auth_success=govbr_linked");
  const identity = db.prepare("SELECT * FROM external_identities").get();
  assert.match(identity.subject_hash, /^[a-f0-9]{64}$/);
  assert.equal(identity.user_id, professor.id);
  assert.notEqual(identity.subject_hash, "12345678901");
  assert.equal((await (await b.request("/api/me")).json()).govbrLinked, true);
  assert.match(
    (await callback(b, start)).headers.get("location"),
    /govbr_invalid_flow/,
  );
  const otherBrowser = browser(),
    logged = await callback(otherBrowser, await flow(otherBrowser));
  assert.equal(logged.headers.get("location"), "/");
  const me = await (await otherBrowser.request("/api/me")).json();
  assert.equal(me.id, professor.id);
  assert.equal(me.role, "PROFESSOR");
});
test("nonce, audience, issuer, assinatura JWT, validade e PKCE adulterados são rejeitados", async () => {
  for (const overrides of [
    { nonce: "forged" },
    { audience: "other-client" },
    { issuer: "https://wrong.example" },
    { badSignature: true },
    { expired: true },
    { challenge: "forged" },
  ]) {
    const b = browser();
    const r = await callback(b, await flow(b), overrides);
    assert.match(r.headers.get("location"), /govbr_invalid_response/);
    assert.equal((await b.request("/api/me")).status, 401);
  }
});
test("outra conta não pode capturar uma identidade já vinculada; vínculo não pode ser trocado silenciosamente", async () => {
  createUser(db, {
    name: "Outra professora",
    email: "other@mock.local",
    role: "PROFESSOR",
    password,
  });
  const other = browser();
  await login(other, "other@mock.local");
  assert.match(
    (await callback(other, await flow(other, "link"))).headers.get("location"),
    /govbr_already_linked/,
  );
  const owner = browser();
  await login(owner, "prof@mock.local");
  assert.match(
    (
      await callback(owner, await flow(owner, "link"), { sub: "98765432100" })
    ).headers.get("location"),
    /govbr_already_linked/,
  );
});
test("conta desativada continua impedida de entrar com GOV.BR", async () => {
  db.prepare("UPDATE users SET active=0 WHERE id=?").run(professor.id);
  const b = browser();
  assert.match(
    (await callback(b, await flow(b))).headers.get("location"),
    /govbr_account_disabled/,
  );
  assert.equal((await b.request("/api/me")).status, 401);
});
