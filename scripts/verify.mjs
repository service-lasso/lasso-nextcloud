import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageNextcloud } from "./package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const nextcloudVersion = process.env.NEXTCLOUD_VERSION ?? "34.0.4";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function waitForClosed(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
      socket.once("connect", () => { socket.end(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (!open) return;
    await sleep(250);
  }
  throw new Error("FastCGI listener remained open after the launcher stopped.");
}

const artifact = process.env.NEXTCLOUD_PACKAGE_ARCHIVE ?? await packageNextcloud(platform, nextcloudVersion);
const verifyRoot = path.join(repoRoot, "output", "verify", nextcloudVersion, platform);
const serviceRoot = path.join(verifyRoot, "service");
const extractRoot = path.join(serviceRoot, ".state", "extracted", "current");
const serviceManifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));
const port = await reserveLoopbackPort();

if (serviceManifest.id !== "nextcloud" || serviceManifest.version !== nextcloudVersion) {
  throw new Error(`Unexpected service manifest identity: ${JSON.stringify({ id: serviceManifest.id, version: serviceManifest.version })}`);
}
if ("healthchecks" in serviceManifest) {
  throw new Error("Nextcloud service.json must use the supported singular healthcheck for Core import compatibility.");
}
if ("ports" in serviceManifest || "urls" in serviceManifest) {
  throw new Error("Nextcloud service.json must author interfaces through canonical endpoints[] only.");
}

const endpoints = serviceManifest.endpoints ?? [];
const fastcgi = endpoints.find((endpoint) => endpoint.id === "fastcgi");
if (fastcgi?.kind !== "network" || fastcgi?.transport !== "tcp") {
  throw new Error("Nextcloud service.json must declare a canonical FastCGI network endpoint.");
}
if (fastcgi.bind !== "127.0.0.1" || fastcgi.port?.default !== 9000 || fastcgi.port?.strategy !== "preferred") {
  throw new Error("Nextcloud FastCGI endpoint must bind loopback on preferred port 9000.");
}
const healthcheck = serviceManifest.healthcheck;
if (
  healthcheck?.type !== "tcp" ||
  healthcheck?.address !== "${endpoint.fastcgi.bind}:${endpoint.fastcgi.port}"
) {
  throw new Error(`Nextcloud service.json healthcheck drifted: ${JSON.stringify(healthcheck)}`);
}
for (const dependency of ["@node", "postgres", "zitadel"]) {
  if (!(serviceManifest.depend_on ?? []).includes(dependency)) {
    throw new Error(`Nextcloud service.json must depend on ${dependency}.`);
  }
}
for (const key of ["NEXTCLOUD_FASTCGI_PORT", "NEXTCLOUD_DB_TYPE", "NEXTCLOUD_DB_NAME", "NEXTCLOUD_OIDC_ISSUER"]) {
  if (!serviceManifest.env?.[key]) {
    throw new Error(`Nextcloud service.json is missing env ${key}.`);
  }
}

await rm(verifyRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });
run("tar", ["-xf", artifact, "-C", extractRoot]);

const metadata = JSON.parse(await readFile(path.join(extractRoot, "SERVICE-LASSO-PACKAGE.json"), "utf8"));
if (metadata.serviceId !== "nextcloud" || metadata.upstream?.version !== nextcloudVersion) {
  throw new Error(`Unexpected package metadata: ${JSON.stringify(metadata)}`);
}

for (const file of serviceManifest.install?.files ?? []) {
  const target = path.resolve(serviceRoot, file.path);
  if (!target.startsWith(serviceRoot + path.sep)) throw new Error("Install file escapes owned service root.");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, file.content ?? "");
}

const phpDir = path.join(extractRoot, "php");
const phpBin = path.join(phpDir, platform === "win32" ? "php.exe" : "php");
const fastcgiBin = path.join(phpDir, platform === "win32" ? "php-cgi.exe" : "php-fpm");
const configDir = path.join(serviceRoot, "runtime", "config");

// The static-php Linux/macOS builds do not include pdo_sqlite, so the
// self-contained SQLite smoke cannot run there; the functional Postgres journey
// is covered by the E2E. Select a database when one is usable, otherwise assert
// packaging only.
function hasExtension(name) {
  const result = spawnSync(phpBin, ["-c", path.join(extractRoot, "php.ini"), "-m"], { encoding: "utf8", windowsHide: true });
  return new RegExp(`(^|\\n)${name}\\b`, "m").test(result.stdout ?? "");
}
const pgHost = process.env.NEXTCLOUD_VERIFY_PG_HOST;
const dbKind = pgHost ? "pgsql" : (hasExtension("pdo_sqlite") ? "sqlite" : "none");

const childEnv = {
  ...process.env,
  SERVICE_ROOT: serviceRoot,
  SERVICE_PORT: String(port),
  NEXTCLOUD_FASTCGI_HOST: "127.0.0.1",
  NEXTCLOUD_FASTCGI_PORT: String(port),
  NEXTCLOUD_DB_TYPE: dbKind === "pgsql" ? "pgsql" : "sqlite",
  NEXTCLOUD_DB_NAME: process.env.NEXTCLOUD_VERIFY_PG_NAME ?? "nextcloud",
  NEXTCLOUD_DB_HOST: pgHost ?? "127.0.0.1",
  NEXTCLOUD_DB_PORT: process.env.NEXTCLOUD_VERIFY_PG_PORT ?? "5432",
  NEXTCLOUD_DB_USER: process.env.NEXTCLOUD_VERIFY_PG_USER ?? "postgres",
  NEXTCLOUD_DB_PASSWORD: process.env.NEXTCLOUD_VERIFY_PG_PASSWORD ?? "postgres",
  NEXTCLOUD_CONFIG_DIR: configDir,
  NEXTCLOUD_DATA_DIR: path.join(serviceRoot, "runtime", "data"),
  NEXTCLOUD_APPS_DIR: path.join(serviceRoot, "runtime", "apps"),
  NEXTCLOUD_ADMIN_USER: "admin",
  NEXTCLOUD_ADMIN_PASSWORD: "service-lasso",
  NEXTCLOUD_ADMIN_EMAIL: "admin@service-lasso.local",
  PATH: phpDir + path.delimiter + (process.env.PATH ?? ""),
};

let child;
let output = "";
function launch() {
  child = spawn(process.execPath, ["./lasso-nextcloud.mjs"], {
    cwd: extractRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return child;
}

function parseJson(text) {
  const start = text.indexOf("{");
  return JSON.parse(start >= 0 ? text.slice(start) : "{}");
}

function occStatus() {
  const result = spawnSync(
    path.join(phpDir, platform === "win32" ? "php.exe" : "php"),
    ["-c", path.join(extractRoot, "php.ini"), path.join(extractRoot, "occ.php"), "status", "--output=json", "--no-warnings"],
    { cwd: extractRoot, env: childEnv, encoding: "utf8", windowsHide: true, timeout: 120_000 },
  );
  return result;
}

async function wrapperStop() {
  const stopped = new Promise((resolve) => child.once("close", resolve));
  if (platform === "win32") child.send("shutdown");
  else child.kill("SIGTERM");
  let timer;
  try {
    await Promise.race([
      stopped,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Launcher shutdown timed out.")), 30_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (child.exitCode !== 0) throw new Error(`Launcher shutdown failed: ${child.exitCode}`);
  await waitForClosed(port);
}

const cycles = [];
if (dbKind === "none") {
  if (!existsSync(path.join(extractRoot, "SERVICE-LASSO-PACKAGE.json"))) {
    throw new Error("Package metadata is missing from the archive.");
  }
  if (!existsSync(fastcgiBin)) {
    throw new Error(`FastCGI binary is missing from the archive: ${fastcgiBin}`);
  }
  const version = spawnSync(fastcgiBin, ["-v"], { encoding: "utf8", windowsHide: true });
  if (version.status !== 0) {
    throw new Error(`FastCGI binary did not run: ${version.stderr || version.stdout}`);
  }
  await writeFile(
    path.join(verifyRoot, "lifecycle-verification.json"),
    JSON.stringify(
      {
        platform,
        artifact,
        backend: platform === "win32" ? "php-cgi" : "php-fpm",
        database: "skipped (no pdo_sqlite in the static-php build)",
        note: "packaging + FastCGI runtime only; the functional database/WebDAV journey is covered by the E2E (PostgreSQL)",
      },
      null,
      2,
    ),
  );
  console.log("[lasso-nextcloud] packaging and FastCGI runtime PASS (database smoke skipped)");
  process.exit(0);
}

try {
  launch();
  await waitForTcp(port);
  const first = occStatus();
  const firstStatus = parseJson(first.stdout ?? "");
  if (firstStatus.installed !== true) throw new Error(`Nextcloud not installed after start: ${first.stdout}`);
  cycles.push({ installed: firstStatus.installed, version: firstStatus.versionstring });
  await wrapperStop();

  launch();
  await waitForTcp(port);
  const secondStatus = parseJson(occStatus().stdout ?? "");
  if (secondStatus.installed !== true) throw new Error("Nextcloud did not retain its installation across restart.");
  cycles.push({ installed: secondStatus.installed, retained: true });
  await wrapperStop();

  await writeFile(
    path.join(verifyRoot, "lifecycle-verification.json"),
    JSON.stringify(
      {
        platform,
        artifact,
        backend: platform === "win32" ? "php-cgi" : "php-fpm",
        database: "sqlite (archive smoke); manifest default pgsql",
        cycles,
        listenerClosedAfterEachWrapperStop: true,
      },
      null,
      2,
    ),
  );
  console.log("[lasso-nextcloud] FastCGI install, readiness and retained restart PASS");
} catch (error) {
  console.error(output);
  throw error;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      if (platform === "win32") child.send("shutdown");
      else child.kill("SIGTERM");
    } catch {
      // Best-effort cleanup only.
    }
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), sleep(10_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
