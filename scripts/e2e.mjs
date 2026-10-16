import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageNextcloud } from "./package.mjs";

// Full-stack end-to-end acceptance for the managed FastCGI backend.
//
// Always: package -> install against the configured database -> FastCGI
// readiness -> occ status installed -> restart retention.
// When a front is available (NEXTCLOUD_E2E_CADDY_BIN test front, or
// NEXTCLOUD_E2E_FRONT_BASE_URL from lasso-caddy): a real Nextcloud WebDAV file
// round-trip, and when NEXTCLOUD_E2E_OIDC_ISSUER is set, ZITADEL OIDC discovery,
// the user_oidc provider registration and a real login redirect.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const nextcloudVersion = process.env.NEXTCLOUD_VERSION ?? "34.0.4";
const adminUser = process.env.NEXTCLOUD_ADMIN_USER ?? "admin";
const adminPassword = process.env.NEXTCLOUD_ADMIN_PASSWORD ?? "service-lasso";
const oidcIssuer = (process.env.NEXTCLOUD_E2E_OIDC_ISSUER ?? "").trim().replace(/\/+$/, "");
const caddyBin = (process.env.NEXTCLOUD_E2E_CADDY_BIN ?? "").trim();
const externalFront = (process.env.NEXTCLOUD_E2E_FRONT_BASE_URL ?? "").trim().replace(/\/+$/, "");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", shell: false, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve loopback port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForTcp(port, timeoutMs = 1_800_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("connect timeout")); });
        socket.once("connect", () => { socket.end(); resolve(); });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError ?? new Error(`Timed out waiting for FastCGI on ${port}.`);
}

function basicAuth() {
  return "Basic " + Buffer.from(`${adminUser}:${adminPassword}`).toString("base64");
}

async function webdavRoundTrip(base, name, content) {
  const url = `${base}/remote.php/dav/files/${adminUser}/${name}`;
  const put = await fetch(url, { method: "PUT", headers: { Authorization: basicAuth(), "Content-Type": "text/plain" }, body: content });
  if (put.status !== 201 && put.status !== 204) throw new Error(`WebDAV PUT ${url} returned ${put.status}`);
  const get = await fetch(url, { headers: { Authorization: basicAuth() } });
  if (get.status !== 200) throw new Error(`WebDAV GET ${url} returned ${get.status}`);
  const body = await get.text();
  if (body !== content) throw new Error(`WebDAV GET body mismatch: ${JSON.stringify(body)}`);
  return { url, status: { put: put.status, get: get.status } };
}

function occ(extractRoot, env, args) {
  const php = path.join(extractRoot, "php", platform === "win32" ? "php.exe" : "php");
  return spawnSync(php, ["-c", path.join(extractRoot, "php.ini"), path.join(extractRoot, "occ.php"), ...args], {
    cwd: extractRoot, env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true, timeout: 300_000,
  });
}

function parseJson(text) {
  const start = (text ?? "").indexOf("{");
  try { return JSON.parse(start >= 0 ? text.slice(start) : "{}"); } catch { return {}; }
}

function occStatus(extractRoot, env) {
  return parseJson(occ(extractRoot, env, ["status", "--output=json", "--no-warnings"]).stdout);
}

const artifact = process.env.NEXTCLOUD_PACKAGE_ARCHIVE ?? await packageNextcloud(platform, nextcloudVersion);
const runRoot = path.join(repoRoot, "output", "e2e", nextcloudVersion, platform);
const serviceRoot = path.join(runRoot, "service");
const extractRoot = path.join(serviceRoot, ".state", "extracted", "current");
const serviceManifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));
const fcgiPort = await reserveLoopbackPort();
const report = { platform, database: "sqlite", backend: platform === "win32" ? "php-cgi" : "php-fpm", front: null, steps: [] };

const childEnv = {
  SERVICE_ROOT: serviceRoot,
  SERVICE_PORT: String(fcgiPort),
  NEXTCLOUD_FASTCGI_HOST: "127.0.0.1",
  NEXTCLOUD_FASTCGI_PORT: String(fcgiPort),
  NEXTCLOUD_CONFIG_DIR: path.join(serviceRoot, "runtime", "config"),
  NEXTCLOUD_DATA_DIR: path.join(serviceRoot, "runtime", "data"),
  NEXTCLOUD_APPS_DIR: path.join(serviceRoot, "runtime", "apps"),
  NEXTCLOUD_ADMIN_USER: adminUser,
  NEXTCLOUD_ADMIN_PASSWORD: adminPassword,
  NEXTCLOUD_ADMIN_EMAIL: process.env.NEXTCLOUD_ADMIN_EMAIL ?? "admin@service-lasso.local",
  PATH: `${path.join(extractRoot, "php")}${path.delimiter}${process.env.PATH ?? ""}`,
};

if (process.env.NEXTCLOUD_E2E_PG_HOST) {
  report.database = "pgsql";
  childEnv.NEXTCLOUD_DB_TYPE = "pgsql";
  childEnv.NEXTCLOUD_DB_NAME = process.env.NEXTCLOUD_E2E_PG_NAME ?? "nextcloud";
  childEnv.NEXTCLOUD_DB_HOST = process.env.NEXTCLOUD_E2E_PG_HOST;
  childEnv.NEXTCLOUD_DB_PORT = process.env.NEXTCLOUD_E2E_PG_PORT ?? "5432";
  childEnv.NEXTCLOUD_DB_USER = process.env.NEXTCLOUD_E2E_PG_USER ?? "postgres";
  childEnv.NEXTCLOUD_DB_PASSWORD = process.env.NEXTCLOUD_E2E_PG_PASSWORD ?? "postgres";
} else {
  childEnv.NEXTCLOUD_DB_TYPE = "sqlite";
  childEnv.NEXTCLOUD_DB_NAME = "nextcloud";
}

if (oidcIssuer) {
  childEnv.NEXTCLOUD_OIDC_ISSUER = oidcIssuer;
  childEnv.NEXTCLOUD_OIDC_CLIENT_ID = process.env.NEXTCLOUD_OIDC_CLIENT_ID ?? "nextcloud-e2e";
  childEnv.NEXTCLOUD_OIDC_CLIENT_SECRET = process.env.NEXTCLOUD_OIDC_CLIENT_SECRET ?? "nextcloud-e2e-secret";
  childEnv.NEXTCLOUD_OIDC_PROVIDER_NAME = process.env.NEXTCLOUD_OIDC_PROVIDER_NAME ?? "Zitadel";
}

let child;
let front;
let frontBase = externalFront || null;
function launch() {
  child = spawn(process.execPath, ["./lasso-nextcloud.mjs"], {
    cwd: extractRoot, env: { ...process.env, ...childEnv }, stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true,
  });
  return child;
}

async function startCaddyFront() {
  const httpPort = await reserveLoopbackPort();
  const caddyfile = path.join(runRoot, "Caddyfile");
  const root = path.join(extractRoot, "nextcloud").replaceAll("\\", "/");
  await writeFile(caddyfile, `{\n\tauto_https off\n}\nhttp://127.0.0.1:${httpPort} {\n\troot * ${root}\n\tphp_fastcgi 127.0.0.1:${fcgiPort}\n\tfile_server\n}\n`, "utf8");
  front = spawn(caddyBin, ["run", "--config", caddyfile, "--adapter", "caddyfile"], { cwd: runRoot, stdio: ["ignore", "ignore", "inherit"] });
  frontBase = `http://127.0.0.1:${httpPort}`;
  report.front = "caddy";
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${frontBase}/status.php`); if (r.status === 200) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("Test Caddy front did not become ready.");
}

async function stop() {
  const closed = new Promise((resolve) => child.once("close", resolve));
  if (platform === "win32") child.send("shutdown");
  else child.kill("SIGTERM");
  await Promise.race([closed, sleep(30_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

await rm(runRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });
run("tar", ["-xf", artifact, "-C", extractRoot]);
for (const file of serviceManifest.install?.files ?? []) {
  const target = path.resolve(serviceRoot, file.path);
  if (!target.startsWith(serviceRoot + path.sep)) throw new Error("Install file escapes owned service root.");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, file.content ?? "");
}

let name = null;
let content = null;
try {
  launch();
  await waitForTcp(fcgiPort);
  const status = occStatus(extractRoot, childEnv);
  if (status.installed !== true) throw new Error(`Nextcloud not installed after start: ${JSON.stringify(status)}`);
  report.steps.push({ step: "install", backend: report.backend, installed: status.installed, version: status.versionstring });

  if (!frontBase && caddyBin) await startCaddyFront();
  if (frontBase) {
    name = `e2e-${Date.now()}.txt`;
    content = `lasso-nextcloud e2e ${new Date().toISOString()}`;
    const dav = await webdavRoundTrip(frontBase, name, content);
    report.steps.push({ step: "webdav", ...dav });

    if (oidcIssuer) {
      const discovery = await fetch(`${oidcIssuer}/.well-known/openid-configuration`).then((r) => { if (!r.ok) throw new Error(`OIDC discovery ${r.status}`); return r.json(); });
      if (discovery.issuer !== oidcIssuer) throw new Error(`OIDC issuer mismatch: ${discovery.issuer}`);
      report.steps.push({ step: "oidc-discovery", issuer: discovery.issuer });
      const providers = occ(extractRoot, childEnv, ["user_oidc:providers", "--output=json", "--no-warnings"]);
      const providersText = providers.stdout ?? "";
      const objStart = providersText.indexOf("{");
      const arrStart = providersText.indexOf("[");
      const start = arrStart >= 0 && (objStart < 0 || arrStart < objStart) ? arrStart : objStart;
      const parsedProviders = start >= 0 ? JSON.parse(providersText.slice(start)) : null;
      const configured = (Array.isArray(parsedProviders) ? parsedProviders[0] : parsedProviders) ?? null;
      if (!configured) throw new Error(`No user_oidc provider configured: ${providersText}`);
      const login = await fetch(`${frontBase}/apps/user_oidc/login/${configured.id}`, { redirect: "manual" });
      const location = login.headers.get("location") ?? "";
      if (login.status < 300 || login.status >= 400 || !location.startsWith(oidcIssuer)) {
        throw new Error(`OIDC login did not redirect to provider: ${login.status} ${location}`);
      }
      report.steps.push({ step: "oidc-login-redirect", status: login.status });
    }
  } else {
    report.steps.push({ step: "http", skipped: "no front provided (set NEXTCLOUD_E2E_CADDY_BIN or NEXTCLOUD_E2E_FRONT_BASE_URL)" });
  }

  await stop();
  launch();
  await waitForTcp(fcgiPort);
  const retainedStatus = occStatus(extractRoot, childEnv);
  if (retainedStatus.installed !== true) throw new Error("Installation was not retained across restart.");
  report.steps.push({ step: "restart-retained", passed: true });
  await stop();

  await writeFile(path.join(runRoot, "e2e-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log("[lasso-nextcloud] E2E PASS");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    try { await stop(); } catch { /* best effort */ }
  }
  if (front && front.exitCode === null && front.signalCode === null) {
    try { front.kill("SIGTERM"); } catch { /* best effort */ }
  }
}
