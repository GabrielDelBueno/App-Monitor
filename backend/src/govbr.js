import * as oidc from "openid-client";
import { readFileSync } from "node:fs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { id, transaction } from "./database.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cookieName = "am_govbr_flow";
const flowCookieOptions = (secure) => ({
  httpOnly: true,
  secure,
  sameSite: "lax",
  path: "/auth/govbr",
  maxAge: 600000,
});
function readSecret(env, name) {
  return env[`${name}_FILE`]
    ? readFileSync(env[`${name}_FILE`], "utf8").trim()
    : env[name];
}
function validateMetadata(metadata, origin) {
  for (const field of [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
  ]) {
    if (
      typeof metadata[field] !== "string" ||
      new URL(metadata[field]).origin !== origin
    )
      throw Error(`Metadado GOV.BR inválido: ${field}`);
  }
  if (
    metadata.userinfo_endpoint &&
    new URL(metadata.userinfo_endpoint).origin !== origin
  )
    throw Error("Metadado GOV.BR inválido: userinfo_endpoint");
}
export function govbrFromEnvironment(env = process.env) {
  if (env.GOVBR_ENABLED !== "true") return null;
  if (!["homologacao", "producao"].includes(env.GOVBR_ENVIRONMENT))
    throw Error("GOVBR_ENVIRONMENT deve ser homologacao ou producao.");
  const issuerOrigin =
    env.GOVBR_ENVIRONMENT === "producao"
      ? "https://sso.acesso.gov.br"
      : "https://sso.staging.acesso.gov.br";
  const issuer = new URL(env.GOVBR_ISSUER || issuerOrigin);
  if (issuer.origin !== issuerOrigin || issuer.search || issuer.hash)
    throw Error("Issuer GOV.BR incompatível com o ambiente selecionado.");
  const publicUrl = new URL(env.PUBLIC_BASE_URL || "");
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.username ||
    publicUrl.password
  )
    throw Error(
      "PUBLIC_BASE_URL deve ser a origem HTTPS pública da aplicação.",
    );
  if (env.COOKIE_SECURE !== "true")
    throw Error("GOV.BR requer COOKIE_SECURE=true.");
  const clientId = env.GOVBR_CLIENT_ID,
    clientSecret = readSecret(env, "GOVBR_CLIENT_SECRET"),
    subjectKey = readSecret(env, "GOVBR_SUBJECT_KEY");
  if (!clientId || !clientSecret || !subjectKey || subjectKey.length < 32)
    throw Error(
      "Configure GOVBR_CLIENT_ID, o client_secret e uma GOVBR_SUBJECT_KEY estável com pelo menos 32 caracteres.",
    );
  let cached;
  return {
    environment: env.GOVBR_ENVIRONMENT,
    baseUrl: publicUrl.origin,
    subjectKey,
    async configuration() {
      if (!cached)
        cached = (async () => {
          let config;
          if (env.GOVBR_METADATA_FILE) {
            const metadata = JSON.parse(
              readFileSync(env.GOVBR_METADATA_FILE, "utf8"),
            );
            validateMetadata(metadata, issuerOrigin);
            config = new oidc.Configuration(
              metadata,
              clientId,
              {
                client_secret: clientSecret,
                id_token_signed_response_alg: "RS256",
              },
              oidc.ClientSecretBasic(clientSecret),
            );
          } else {
            config = await oidc.discovery(
              issuer,
              clientId,
              {
                client_secret: clientSecret,
                id_token_signed_response_alg: "RS256",
              },
              oidc.ClientSecretBasic(clientSecret),
            );
            validateMetadata(config.serverMetadata(), issuerOrigin);
          }
          config.timeout = 15;
          oidc.enableNonRepudiationChecks(config);
          return config;
        })().catch((error) => {
          cached = undefined;
          throw error;
        });
      return cached;
    },
  };
}
export function registerGovbr({
  app,
  db,
  secure,
  settings,
  issueSession,
  sessionUser,
  setupAvailable = () => false,
}) {
  const get = (sql, ...args) => db.prepare(sql).get(...args),
    run = (sql, ...args) => db.prepare(sql).run(...args);
  const identityHash = (issuer, subject) =>
    createHmac("sha256", settings.subjectKey)
      .update(JSON.stringify([issuer, subject]))
      .digest("hex");
  app.get("/api/auth/config", async (_req, res) =>
    res.json({
      govbr: !!settings,
      environment: settings?.environment || null,
      needsSetup: await setupAvailable(),
    }),
  );
  const errorRedirect = (res, code) =>
    res.redirect(303, `/?auth_error=${code}`);
  const begin = (mode) => async (req, res) => {
    if (!settings)
      return res.status(503).json({
        erro: "GOV.BR não está configurado.",
      });
    const actor = mode === "link" ? await sessionUser(req) : null;
    if (
      mode === "link" &&
      (!actor ||
        actor.user.role !== "PROFESSOR" ||
        actor.user.must_change_password)
    )
      return res.status(403).json({
        erro: "Entre na conta do professor para vincular GOV.BR.",
      });
    try {
      const config = await settings.configuration(),
        state = oidc.randomState(),
        nonce = oidc.randomNonce(),
        verifier = oidc.randomPKCECodeVerifier(),
        browserToken = randomBytes(32).toString("hex");
      const callback = new URL("/auth/govbr/callback", settings.baseUrl).href;
      const url = oidc.buildAuthorizationUrl(config, {
        response_type: "code",
        redirect_uri: callback,
        scope: "openid profile email",
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      });
      await transaction(db, async () => {
        await run("DELETE FROM oauth_flows WHERE expires_at<?", Date.now());
        await run(
          "INSERT INTO oauth_flows VALUES(?,?,?,?,?,?,?,?,?)",
          hash(state),
          hash(browserToken),
          verifier,
          nonce,
          callback,
          mode,
          actor?.user.id || null,
          actor?.sessionHash || null,
          Date.now() + 600000,
        );
      });
      res.cookie(cookieName, browserToken, flowCookieOptions(secure));
      res.set("Cache-Control", "no-store");
      res.redirect(303, url.href);
    } catch (error) {
      console.warn("GOV.BR indisponível:", error.code || error.name);
      errorRedirect(res, "govbr_unavailable");
    }
  };
  app.get("/auth/govbr", begin("login"));
  app.get("/auth/govbr/link", begin("link"));
  app.get("/auth/govbr/callback", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const browser =
      (req.headers.cookie || "")
        .split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1) || "";
    const flow = state
      ? await get("SELECT * FROM oauth_flows WHERE state_hash=?", hash(state))
      : null;
    if (
      !settings ||
      !flow ||
      flow.expires_at < Date.now() ||
      !browser ||
      hash(browser) !== flow.browser_hash
    )
      return errorRedirect(res, "govbr_invalid_flow");
    // Consume before any network request: one callback per browser-bound flow.
    await run("DELETE FROM oauth_flows WHERE state_hash=?", flow.state_hash);
    res.clearCookie(cookieName, {
      ...flowCookieOptions(secure),
      maxAge: undefined,
    });
    if (req.query.error) return errorRedirect(res, "govbr_cancelled");
    try {
      const config = await settings.configuration();
      const url = new URL(req.originalUrl, settings.baseUrl);
      const tokens = await oidc.authorizationCodeGrant(config, url, {
        expectedState: state,
        expectedNonce: flow.nonce,
        pkceCodeVerifier: flow.code_verifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (
        !claims ||
        typeof claims.sub !== "string" ||
        !claims.sub ||
        claims.sub.length > 200
      )
        throw Error("ID token sem identidade válida.");
      const issuer = config.serverMetadata().issuer,
        subjectHash = identityHash(issuer, claims.sub);
      let user;
      if (flow.mode === "link") {
        const activeSession = await get(
          "SELECT user_id FROM sessions WHERE token=? AND user_id=? AND expires_at>?",
          flow.session_hash,
          flow.user_id,
          Date.now(),
        );
        user = await get(
          "SELECT id,name,email,role,active FROM users WHERE id=? AND role='PROFESSOR' AND active=1",
          flow.user_id,
        );
        if (!activeSession || !user)
          return errorRedirect(res, "govbr_account_disabled");
        const existing = await get(
          "SELECT * FROM external_identities WHERE issuer=? AND subject_hash=?",
          issuer,
          subjectHash,
        );
        const own = await get(
          "SELECT * FROM external_identities WHERE issuer=? AND user_id=?",
          issuer,
          user.id,
        );
        if (
          (existing && existing.user_id !== user.id) ||
          (own && own.subject_hash !== subjectHash)
        )
          return errorRedirect(res, "govbr_already_linked");
        await transaction(db, async () => {
          if (!existing)
            await run(
              "INSERT INTO external_identities VALUES(?,?,?,?,?)",
              id(),
              user.id,
              issuer,
              subjectHash,
              new Date().toISOString(),
            );
          await run(
            "INSERT INTO audit VALUES(?,?,?,?,?,?)",
            id(),
            user.id,
            "VINCULAR_GOVBR",
            user.id,
            JSON.stringify({
              environment: settings.environment,
            }),
            new Date().toISOString(),
          );
        });
      } else {
        user = await get(
          "SELECT u.id,u.name,u.email,u.role,u.active FROM external_identities e JOIN users u ON u.id=e.user_id WHERE e.issuer=? AND e.subject_hash=? AND u.role='PROFESSOR'",
          issuer,
          subjectHash,
        );
        if (!user) return errorRedirect(res, "govbr_not_linked");
        if (!user.active) return errorRedirect(res, "govbr_account_disabled");
      }
      await issueSession(res, user, "LOGIN_GOVBR");
      res.redirect(
        303,
        flow.mode === "link" ? "/?auth_success=govbr_linked" : "/",
      );
    } catch (error) {
      console.warn("Falha de autenticação GOV.BR:", error.code || error.name);
      errorRedirect(res, "govbr_invalid_response");
    }
  });
}
