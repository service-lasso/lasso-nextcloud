import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bootstrapOidc, desiredApplication, planFor } from "./oidc-bootstrap.mjs";

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function matchingState(desired) {
  return {
    projects: {
      [desired.project]: {
        applications: {
          [desired.application]: {
            redirectUris: desired.redirectUris,
            postLogoutRedirectUris: desired.postLogoutRedirectUris,
            allowedOrigins: desired.allowedOrigins,
            grantTypes: desired.grantTypes,
            responseTypes: desired.responseTypes,
            authMethod: desired.authMethod,
          },
        },
      },
    },
  };
}

test("missing state plans a create with canonical endpoints", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nc-oidc-"));
  try {
    const outputPath = path.join(dir, "metadata.json");
    const env = { ZITADEL_BOOTSTRAP_METADATA_PATH: outputPath, NEXTCLOUD_OIDC_ISSUER: "http://localhost:18084/" };
    const { plan, metadata } = await bootstrapOidc(env);
    assert.equal(plan, "create");
    assert.equal(metadata.issuer, "http://localhost:18084");
    assert.equal(metadata.discoveryUri, "http://localhost:18084/.well-known/openid-configuration");
    assert.deepEqual(metadata.redirectUris, ["http://127.0.0.1:8520/apps/user_oidc/code"]);
    assert.deepEqual(metadata.allowedOrigins, ["http://127.0.0.1:8520"]);
    assert.equal(metadata.authMethod, "client_secret_basic");
    assert.equal(metadata.clientSecretRef, "secretref://@secretsbroker/zitadel/nextcloud/client-secret");

    const written = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(written, metadata);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("matching state plans a noop", () => {
  const desired = desiredApplication({ NEXTCLOUD_OIDC_ISSUER: "http://localhost:18084" });
  assert.equal(planFor(matchingState(desired), desired), "noop");
});

test("drifted redirect plans an update", () => {
  const desired = desiredApplication({ NEXTCLOUD_OIDC_ISSUER: "http://localhost:18084" });
  const state = matchingState(desired);
  state.projects[desired.project].applications[desired.application].redirectUris = ["http://127.0.0.1:9999/callback"];
  assert.equal(planFor(state, desired), "update");
});

test("metadata never contains raw secrets or tokens", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nc-oidc-"));
  try {
    const env = {
      ZITADEL_BOOTSTRAP_METADATA_PATH: path.join(dir, "metadata.json"),
      NEXTCLOUD_OIDC_SECRET: "super-secret-value",
      NEXTCLOUD_OIDC_CLIENT_ID: "nextcloud-client",
    };
    const { metadata } = await bootstrapOidc(env);
    const serialized = JSON.stringify(metadata);
    assert.ok(!serialized.includes("super-secret-value"), "raw secret leaked into metadata");
    assert.ok(!("clientSecret" in metadata), "clientSecret key must not be present");
    assert.equal(metadata.clientId, "nextcloud-client");
    assert.ok(metadata.clientSecretRef.startsWith("secretref://"), "secret must be referenced, not inlined");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

if (failures > 0) {
  console.error(`\n${failures} OIDC bootstrap contract test(s) failed.`);
  process.exit(1);
}
console.log(`\n${tests.length} OIDC bootstrap contract test(s) passed.`);
