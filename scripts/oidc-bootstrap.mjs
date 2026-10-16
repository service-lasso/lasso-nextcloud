import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Service Lasso OIDC bootstrap contract, mirroring lasso-zitadel's
// scripts/oidc-bootstrap.mjs. It reconciles the desired ZITADEL OIDC
// application settings for the Nextcloud user_oidc backend against a supplied
// state snapshot and emits a metadata-only plan. It never calls the provider,
// never writes secrets, and never prints tokens.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_CALLBACK = `http://127.0.0.1:8520/apps/user_oidc/code`;
const CLIENT_SECRET_REF = "secretref://@secretsbroker/zitadel/nextcloud/client-secret";

function originOf(url) {
  return new URL(url).origin;
}

export function desiredApplication(env = process.env) {
  const callbackUrl = (env.NEXTCLOUD_OIDC_CALLBACK_URL ?? DEFAULT_CALLBACK).trim();
  const callbackOrigin = originOf(callbackUrl);
  const postLogout = (env.NEXTCLOUD_OIDC_POST_LOGOUT_URL ?? `${callbackOrigin}/`).trim();
  const issuer = (env.NEXTCLOUD_OIDC_ISSUER ?? env.ZITADEL_URL ?? "http://localhost:18084").trim().replace(/\/+$/, "");
  const allowedOrigins = [callbackOrigin];
  const configured = (env.NEXTCLOUD_OIDC_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  for (const origin of configured) {
    if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin);
  }

  return {
    project: "service-lasso",
    application: "nextcloud",
    name: "Service Lasso Nextcloud OIDC client",
    issuer,
    discoveryUri: `${issuer}/.well-known/openid-configuration`,
    redirectUris: [callbackUrl],
    postLogoutRedirectUris: [postLogout],
    allowedOrigins,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    authMethod: "client_secret_basic",
    scopes: ["openid", "email", "profile"],
    clientSecretRef: CLIENT_SECRET_REF,
  };
}

function sameStrings(left = [], right = []) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export function applicationMatches(current, desired) {
  if (!current) return false;
  return (
    sameStrings(current.redirectUris, desired.redirectUris) &&
    sameStrings(current.postLogoutRedirectUris, desired.postLogoutRedirectUris) &&
    sameStrings(current.allowedOrigins, desired.allowedOrigins) &&
    sameStrings(current.grantTypes, desired.grantTypes) &&
    sameStrings(current.responseTypes, desired.responseTypes) &&
    current.authMethod === desired.authMethod
  );
}

export function planFor(state, desired) {
  const current = state?.projects?.[desired.project]?.applications?.[desired.application];
  if (!current) return "create";
  return applicationMatches(current, desired) ? "noop" : "update";
}

async function loadState(env) {
  if (env.ZITADEL_BOOTSTRAP_STATE_JSON) {
    return JSON.parse(env.ZITADEL_BOOTSTRAP_STATE_JSON);
  }
  const statePath = env.ZITADEL_BOOTSTRAP_STATE;
  if (statePath) {
    try {
      return JSON.parse(await readFile(path.resolve(statePath), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }
  return {};
}

export async function bootstrapOidc(env = process.env) {
  const desired = desiredApplication(env);
  const state = await loadState(env);
  const plan = planFor(state, desired);
  const current = state?.projects?.[desired.project]?.applications?.[desired.application];

  const metadata = {
    schemaVersion: "1.0.0",
    generatedBy: "service-lasso/lasso-nextcloud",
    provider: "zitadel",
    serviceId: "nextcloud",
    project: desired.project,
    application: desired.application,
    plan,
    issuer: desired.issuer,
    discoveryUri: desired.discoveryUri,
    clientId: env.NEXTCLOUD_OIDC_CLIENT_ID?.trim() || current?.clientId || "",
    clientSecretRef: desired.clientSecretRef,
    redirectUris: desired.redirectUris,
    postLogoutRedirectUris: desired.postLogoutRedirectUris,
    allowedOrigins: desired.allowedOrigins,
    grantTypes: desired.grantTypes,
    responseTypes: desired.responseTypes,
    authMethod: desired.authMethod,
    scopes: desired.scopes,
  };

  const outputPath = path.resolve(env.ZITADEL_BOOTSTRAP_METADATA_PATH ?? path.join(repoRoot, "runtime", "service-lasso-oidc.metadata.json"));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return { plan, metadata, outputPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { plan, outputPath } = await bootstrapOidc();
  console.log(`[lasso-nextcloud] OIDC bootstrap plan: ${plan}`);
  console.log(`[lasso-nextcloud] metadata written to ${outputPath}`);
}
