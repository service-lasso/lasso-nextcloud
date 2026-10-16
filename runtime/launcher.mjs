import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = process.env.SERVICE_ROOT ?? process.cwd();
const runtimeRoot = path.join(serviceRoot, 'runtime');
const configDir = process.env.NEXTCLOUD_CONFIG_DIR ?? path.join(runtimeRoot, 'config');
const dataDir = process.env.NEXTCLOUD_DATA_DIR ?? path.join(runtimeRoot, 'data');
const appsDir = process.env.NEXTCLOUD_APPS_DIR ?? path.join(runtimeRoot, 'apps');
const fastcgiHost = process.env.NEXTCLOUD_FASTCGI_HOST ?? process.env.NEXTCLOUD_HOST ?? '127.0.0.1';
const fastcgiPort = process.env.NEXTCLOUD_FASTCGI_PORT ?? process.env.NEXTCLOUD_PORT ?? process.env.SERVICE_PORT ?? '9000';
const dbType = process.env.NEXTCLOUD_DB_TYPE ?? 'pgsql';
const dbName = process.env.NEXTCLOUD_DB_NAME ?? 'nextcloud';
const dbHost = process.env.NEXTCLOUD_DB_HOST ?? process.env.POSTGRES_HOST ?? '127.0.0.1';
const dbPort = process.env.NEXTCLOUD_DB_PORT ?? process.env.POSTGRES_PORT ?? '8500';
const dbUser = process.env.NEXTCLOUD_DB_USER ?? process.env.POSTGRES_USER ?? 'pgadmin';
const dbPassword = process.env.NEXTCLOUD_DB_PASSWORD ?? process.env.POSTGRES_PASSWORD ?? 'pgadmin';
const adminUser = process.env.NEXTCLOUD_ADMIN_USER ?? 'admin';
const adminPassword = process.env.NEXTCLOUD_ADMIN_PASSWORD ?? 'service-lasso';
const adminEmail = process.env.NEXTCLOUD_ADMIN_EMAIL ?? 'admin@service-lasso.local';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const installTimeoutMs = Number(process.env.NEXTCLOUD_INSTALL_TIMEOUT_MS ?? 1_800_000);
const installGraceMs = Number(process.env.NEXTCLOUD_INSTALL_GRACE_MS ?? 20_000);
const upgradeTimeoutMs = Number(process.env.NEXTCLOUD_UPGRADE_TIMEOUT_MS ?? 900_000);

function findExecutable(name) {
  const candidates = [
    path.join(packageRoot, 'php', name),
    path.join(packageRoot, 'php', 'bin', name),
    path.join(packageRoot, 'php', name + '.exe'),
    path.join(packageRoot, 'php', 'bin', name + '.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  for (const entry of walk(path.join(packageRoot, 'php'))) {
    if (path.basename(entry).toLowerCase() === name.toLowerCase() || path.basename(entry).toLowerCase() === (name + '.exe').toLowerCase()) {
      return entry;
    }
  }
  throw new Error(`Bundled PHP runtime ("${name}") was not found under ${path.join(packageRoot, 'php')}.`);
}

function* walk(root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else {
      yield entryPath;
    }
  }
}

function findNextcloudRoot() {
  const candidate = path.join(packageRoot, 'nextcloud');
  if (!existsSync(path.join(candidate, 'occ'))) {
    throw new Error(`Bundled Nextcloud server was not found under ${candidate}.`);
  }
  return candidate;
}

const php = findExecutable('php');
const fastcgiBinary = process.platform === 'win32' ? findExecutable('php-cgi') : findExecutable('php-fpm');
const phpIni = path.join(packageRoot, 'php.ini');
const nextcloudRoot = findNextcloudRoot();
const occ = path.join(packageRoot, 'occ.php');
const prependFile = path.join(runtimeRoot, 'prepend.php');
const fcgiIni = path.join(runtimeRoot, 'php-fcgi.ini');
const fpmConf = path.join(runtimeRoot, 'php-fpm.conf');
const env = { ...process.env, NEXTCLOUD_CONFIG_DIR: configDir, NEXTCLOUD_DATA_DIR: dataDir };

// The official Windows PHP build cannot create OpenSSL keys without its
// bundled configuration file, which breaks Nextcloud key generation.
const opensslConf = path.join(path.dirname(php), 'extras', 'ssl', 'openssl.cnf');
if (!env.OPENSSL_CONF && existsSync(opensslConf)) {
  env.OPENSSL_CONF = opensslConf;
}

let child;
let exited;
let stopping = false;

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? nextcloudRoot,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
  return result;
}

function phpScript(script, args = []) {
  const iniArgs = existsSync(phpIni) ? ['-c', phpIni] : [];
  return run(path.basename(script), php, [...iniArgs, script, ...args]);
}

function phpIniArgs() {
  return existsSync(phpIni) ? ['-c', phpIni] : [];
}

function occRun(args) {
  return run('occ ' + args.join(' '), php, [...phpIniArgs(), occ, ...args]);
}

function occRunBounded(args, { timeoutMs, allowTimeout = false } = {}) {
  const label = 'occ ' + args.join(' ');
  const result = spawnSync(php, [...phpIniArgs(), occ, ...args], {
    cwd: nextcloudRoot,
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: timeoutMs,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    if (allowTimeout) {
      console.warn(`[lasso-nextcloud] ${label} exceeded ${timeoutMs}ms and was terminated.`);
      return result;
    }
    throw new Error(`${label} timed out after ${timeoutMs}ms.`);
  }
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
  return result;
}

function isInstalled() {
  const configFile = path.join(configDir, 'config.php');
  if (!existsSync(configFile)) return false;
  try {
    return readFileSync(configFile, 'utf8').includes("'installed' => true");
  } catch {
    return false;
  }
}

function ensureDatabase() {
  if (dbType !== 'pgsql') return;
  const script = path.join(packageRoot, 'ensure-database.php');
  if (!existsSync(script)) throw new Error(`Missing database bootstrap script: ${script}`);
  run('ensure-database', php, [
    ...(existsSync(phpIni) ? ['-c', phpIni] : []),
    script,
    dbHost,
    dbPort,
    dbUser,
    dbPassword,
    dbName,
  ]);
}

async function install() {
  ensureDatabase();
  // Nextcloud refuses unattended install unless the deployment config dir
  // carries the CAN_INSTALL marker.
  writeFileSync(path.join(configDir, 'CAN_INSTALL'), '');
  const args = [
    'maintenance:install',
    '--database', dbType,
    '--database-name', dbName,
    '--data-dir', dataDir,
    '--admin-user', adminUser,
    '--admin-pass', adminPassword,
    '--admin-email', adminEmail,
  ];
  if (dbType === 'pgsql') {
    args.push('--database-host', dbHost, '--database-port', dbPort, '--database-user', dbUser, '--database-pass', dbPassword);
  }

  // Some platforms (notably Windows PHP) do not return from the Nextcloud
  // installer after it writes installed=true. Treat that marker as the
  // completion signal, allow a short grace period for a natural exit, then
  // terminate the installer so the managed service can start serving.
  const installer = spawn(php, [...phpIniArgs(), occ, ...args], { cwd: nextcloudRoot, env, stdio: 'inherit', windowsHide: true });
  const exited = new Promise(resolve => {
    installer.once('error', error => { console.error(error.message); resolve(-1); });
    installer.once('exit', code => resolve(code ?? -1));
  });

  const deadline = Date.now() + installTimeoutMs;
  let installed = false;
  while (Date.now() < deadline) {
    if (installer.exitCode !== null || installer.signalCode !== null) break;
    if (isInstalled()) { installed = true; break; }
    await sleep(1000);
  }

  if (!installed) {
    const code = await exited;
    if (!isInstalled()) throw new Error(`occ maintenance:install failed with exit code ${code}.`);
    return;
  }

  if (installer.exitCode === null && installer.signalCode === null) {
    const settled = await Promise.race([
      exited.then(code => ({ kind: 'exit', code })),
      sleep(installGraceMs).then(() => ({ kind: 'grace' })),
    ]);
    if (settled.kind === 'grace') {
      console.warn('[lasso-nextcloud] Nextcloud installer did not return after reporting installed; terminating it.');
      try { installer.kill('SIGKILL'); } catch { /* already gone */ }
      await exited;
    } else if (settled.code !== 0 && settled.code !== -1) {
      console.warn(`[lasso-nextcloud] Nextcloud installer exited with code ${settled.code} after reporting installed; continuing.`);
    }
  }
}

function configure() {
  const script = path.join(packageRoot, 'configure.php');
  if (!existsSync(script)) throw new Error(`Missing configuration script: ${script}`);
  run('configure', php, [
    ...(existsSync(phpIni) ? ['-c', phpIni] : []),
    script,
    appsDir,
  ]);
}

function writeFastcgiRuntime() {
  // FastCGI front-ends do not forward the manager's process environment, so the
  // deployment config/data paths Nextcloud needs are injected into every request
  // via an auto_prepend file.
  const slashes = value => value.replaceAll('\\', '/');
  writeFileSync(prependFile, [
    '<?php',
    'foreach ([',
    `    'NEXTCLOUD_CONFIG_DIR' => '${slashes(configDir).replaceAll("'", "\\'")}',`,
    `    'NEXTCLOUD_DATA_DIR' => '${slashes(dataDir).replaceAll("'", "\\'")}',`,
    `    'NEXTCLOUD_APPS_DIR' => '${slashes(appsDir).replaceAll("'", "\\'")}',`,
    '] as $name => $value) { putenv($name . \'=\' . $value); $_SERVER[$name] = $value; }',
    '',
  ].join('\n'), 'utf8');

  const baseIni = existsSync(phpIni) ? readFileSync(phpIni, 'utf8') : '';
  writeFileSync(fcgiIni, `${baseIni}\nauto_prepend_file="${slashes(prependFile)}"\n`, 'utf8');
}

function writeFpmConfig() {
  writeFileSync(fpmConf, [
    '[global]',
    `pid = ${fpmConf}.pid`.replaceAll('\\', '/'),
    `error_log = ${path.join(runtimeRoot, 'php-fpm.log')}`.replaceAll('\\', '/'),
    'daemonize = no',
    '',
    '[www]',
    `listen = ${fastcgiHost}:${fastcgiPort}`,
    'pm = dynamic',
    'pm.max_children = 8',
    'pm.start_servers = 2',
    'pm.min_spare_servers = 1',
    'pm.max_spare_servers = 4',
    'clear_env = no',
    `env[NEXTCLOUD_CONFIG_DIR] = ${configDir}`.replaceAll('\\', '/'),
    `env[NEXTCLOUD_DATA_DIR] = ${dataDir}`.replaceAll('\\', '/'),
    `env[NEXTCLOUD_APPS_DIR] = ${appsDir}`.replaceAll('\\', '/'),
    '',
  ].join('\n'), 'utf8');
}

function fastcgiArgs() {
  if (process.platform === 'win32') {
    return ['-c', fcgiIni, '-b', `${fastcgiHost}:${fastcgiPort}`];
  }
  writeFpmConfig();
  return ['-F', '--nodaemonize', '--fpm-config', fpmConf, '-c', fcgiIni];
}

function configureOidc() {
  const enabled = (process.env.NEXTCLOUD_OIDC_ENABLED ?? '').trim().toLowerCase();
  if (enabled === 'false' || enabled === '0' || enabled === 'no') {
    console.log('[lasso-nextcloud] OIDC integration disabled by NEXTCLOUD_OIDC_ENABLED.');
    return;
  }

  const issuer = (process.env.NEXTCLOUD_OIDC_ISSUER ?? '').trim();
  const clientId = (process.env.NEXTCLOUD_OIDC_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.NEXTCLOUD_OIDC_CLIENT_SECRET ?? '').trim();
  if (!issuer || !clientId || !clientSecret) {
    console.log('[lasso-nextcloud] OIDC not configured (set NEXTCLOUD_OIDC_ISSUER, CLIENT_ID and CLIENT_SECRET); skipping user_oidc setup.');
    return;
  }

  const providerName = (process.env.NEXTCLOUD_OIDC_PROVIDER_NAME ?? '').trim() || 'Zitadel';
  const scope = (process.env.NEXTCLOUD_OIDC_SCOPE ?? '').trim() || 'openid email profile';
  const discoveryUri = issuer.replace(/\/+$/, '') + '/.well-known/openid-configuration';

  occRunBounded(['app:enable', 'user_oidc'], { timeoutMs: 300_000, allowTimeout: false });
  // The client secret is passed by environment-variable name so it never
  // appears in the managed process command line.
  occRunBounded([
    'user_oidc:provider', providerName,
    '--clientid', clientId,
    '--clientsecret-env', 'NEXTCLOUD_OIDC_CLIENT_SECRET',
    '--discoveryuri', discoveryUri,
    '--scope', scope,
    '--unique-uid', '0',
  ], { timeoutMs: 300_000, allowTimeout: false });
  console.log(`[lasso-nextcloud] configured user_oidc provider "${providerName}" for issuer ${issuer}`);
}

async function stop() {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGTERM');
    } catch {
      // The Windows built-in server cannot receive a catchable signal; the
      // process termination below is the documented fallback.
    }
    await edge(exited, 10_000);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      await edge(exited, 5_000);
    }
  }
  if (process.connected) process.disconnect();
}

function edge(promise, timeoutMs) {
  return Promise.race([
    promise.catch(() => {}),
    sleep(timeoutMs),
  ]);
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('message', message => {
  if (message === 'shutdown') void stop();
});

async function waitForPort(timeoutMs = 1_800_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (!stopping && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: fastcgiHost, port: Number(fastcgiPort) });
        socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('connect timeout')); });
        socket.once('connect', () => { socket.end(); resolve(); });
        socket.once('error', reject);
      });
      return;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  if (!stopping && child.exitCode === null && child.signalCode === null) {
    throw new Error(`Nextcloud FastCGI did not become ready within ${Math.round(timeoutMs / 1000)}s on ${fastcgiHost}:${fastcgiPort}${lastError ? ': ' + lastError.message : ''}`);
  }
}

try {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(appsDir, { recursive: true });

  if (!isInstalled()) {
    console.log('[lasso-nextcloud] first run: installing Nextcloud into ' + configDir);
    await install();
  }
  configure();
  configureOidc();

  // Reconcile schema/version drift before serving; occ upgrade is a no-op when
  // the installed instance already matches the packaged server. It is bounded
  // because an unsupported platform may not return from the command.
  occRunBounded(['upgrade', '--no-interaction'], { timeoutMs: upgradeTimeoutMs, allowTimeout: true });

  writeFastcgiRuntime();
  const spawnArgs = fastcgiArgs();
  if (process.platform === 'win32' && !env.PHP_FCGI_CHILDREN) {
    env.PHP_FCGI_CHILDREN = '4';
  }
  child = spawn(fastcgiBinary, spawnArgs, { cwd: nextcloudRoot, env, stdio: 'inherit', windowsHide: true, detached: false });
  exited = new Promise(resolve => {
    child.once('error', error => {
      console.error(error.message);
      process.exitCode = 1;
      resolve();
    });
    child.once('exit', (code, signal) => {
      if (!stopping) process.exitCode = code === 0 ? 1 : (code ?? 1);
      console.log(`[lasso-nextcloud] foreground FastCGI server exited (code=${code ?? 'null'}${signal ? ', signal=' + signal : ''})`);
      resolve();
    });
  });

  await waitForPort();
  if (!stopping) console.log(`[lasso-nextcloud] ready; FastCGI on ${fastcgiHost}:${fastcgiPort} serving ${nextcloudRoot} (pid ${child.pid})`);
  await exited;
  if (process.connected) process.disconnect();
} catch (error) {
  console.error('[lasso-nextcloud] ' + error.message);
  process.exitCode = 1;
  await stop();
}
