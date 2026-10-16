import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextcloudVersion = process.env.NEXTCLOUD_VERSION ?? "34.0.4";
const phpVersion = process.env.NEXTCLOUD_PHP_VERSION ?? "8.3.32";
const userOidcVersion = process.env.NEXTCLOUD_USER_OIDC_VERSION ?? "8.11.0";
const targetPlatform = process.env.TARGET_PLATFORM ?? process.platform;

const nextcloudBase = "https://download.nextcloud.com/server/releases";
const staticPhpBase = "https://dl.static-php.dev/static-php-cli/bulk";
const windowsPhpBase = "https://windows.php.net/downloads/releases/archives";

const targets = {
  win32: {
    nextcloud: {
      asset: `nextcloud-${nextcloudVersion}.zip`,
      url: `${nextcloudBase}/nextcloud-${nextcloudVersion}.zip`,
      format: "zip",
    },
    php: {
      asset: `php-${phpVersion}-nts-Win32-vs16-x64.zip`,
      url: `${windowsPhpBase}/php-${phpVersion}-nts-Win32-vs16-x64.zip`,
      format: "zip",
      vendor: "https://windows.php.net/downloads/releases/archives/",
    },
    archiveType: "zip",
  },
  linux: {
    nextcloud: {
      asset: `nextcloud-${nextcloudVersion}.tar.bz2`,
      url: `${nextcloudBase}/nextcloud-${nextcloudVersion}.tar.bz2`,
      format: "tar.bz2",
    },
    php: {
      asset: `php-${phpVersion}-cli-linux-x86_64.tar.gz`,
      url: `${staticPhpBase}/php-${phpVersion}-cli-linux-x86_64.tar.gz`,
      format: "tar.gz",
      vendor: "https://static-php.dev/",
    },
    phpFpm: {
      asset: `php-${phpVersion}-fpm-linux-x86_64.tar.gz`,
      url: `${staticPhpBase}/php-${phpVersion}-fpm-linux-x86_64.tar.gz`,
      format: "tar.gz",
    },
    archiveType: "tar.gz",
  },
  darwin: {
    nextcloud: {
      asset: `nextcloud-${nextcloudVersion}.tar.bz2`,
      url: `${nextcloudBase}/nextcloud-${nextcloudVersion}.tar.bz2`,
      format: "tar.bz2",
    },
    php: {
      asset: `php-${phpVersion}-cli-macos-x86_64.tar.gz`,
      url: `${staticPhpBase}/php-${phpVersion}-cli-macos-x86_64.tar.gz`,
      format: "tar.gz",
      vendor: "https://static-php.dev/",
    },
    phpFpm: {
      asset: `php-${phpVersion}-fpm-macos-x86_64.tar.gz`,
      url: `${staticPhpBase}/php-${phpVersion}-fpm-macos-x86_64.tar.gz`,
      format: "tar.gz",
    },
    archiveType: "tar.gz",
  },
};

const phpIniCommon = `[PHP]
date.timezone = UTC
memory_limit = 512M
upload_max_filesize = 512M
post_max_size = 512M
max_execution_time = 3600
max_input_time = 3600
max_input_vars = 5000
default_charset = "UTF-8"
expose_php = Off
display_errors = Off
opcache.enable = 1
opcache.enable_cli = 1
opcache.interned_strings_buffer = 16
opcache.max_accelerated_files = 10000
opcache.memory_consumption = 128
`;

const phpIniWindows = `[PHP]
extension_dir = "ext"
extension=bz2
extension=curl
extension=exif
extension=fileinfo
extension=gd
extension=gmp
extension=intl
extension=mbstring
extension=openssl
extension=pdo_pgsql
extension=pdo_sqlite
extension=pgsql
extension=sodium
extension=sqlite3
extension=zip
zend_extension=opcache
${phpIniCommon.slice("[PHP]\n".length)}`;

// Nextcloud assumes POSIX paths in a few places that break Windows PHP:
// migration discovery matches zero migrations ("no such table: oc_users") and
// the data-directory validator rejects a drive-qualified absolute path. These
// documented compatibility patches are applied to the packaged Windows archive
// only, and are guarded so a changed upstream string fails packaging instead of
// silently shipping a stale patch.
const windowsCompatibilityPatches = [
  {
    file: "lib/private/DB/MigrationService.php",
    from: String.raw`'#^.+\\/Version[^\\/]{1,255}\\.php$#i'`,
    to: String.raw`'#^.+[\\\\/]Version[^\\\\/]{1,255}\\.php$#i'`,
    reason: "Allow both POSIX and Windows directory separators when discovering migrations.",
  },
  {
    file: "lib/private/legacy/OC_Util.php",
    from: String.raw`if ($dataDirectory[0] !== '/') {`,
    to: String.raw`if ($dataDirectory[0] !== '/' && !preg_match('/^[A-Za-z]:[\\\\\\/]/', $dataDirectory)) {`,
    reason: "Accept a Windows drive-qualified absolute data directory.",
  },
  {
    file: "lib/private/Files/Storage/Local.php",
    from: String.raw`if (substr($realPath, 0, $this->dataDirLength) === $this->realDataDir) {`,
    to: String.raw`if (str_replace('\\', '/', substr($realPath, 0, $this->dataDirLength)) === str_replace('\\', '/', $this->realDataDir)) {`,
    reason: "Compare data-directory containment with normalized separators so realpath() output matches on Windows.",
  },
];

async function applyWindowsCompatibilityPatches(nextcloudRoot) {
  for (const patch of windowsCompatibilityPatches) {
    const target = path.join(nextcloudRoot, patch.file);
    if (!existsSync(target)) {
      throw new Error(`Windows compatibility patch target was not found: ${target}`);
    }
    const source = await readFile(target, "utf8");
    if (source.includes(patch.to)) {
      continue;
    }
    if (!source.includes(patch.from)) {
      throw new Error(`Windows compatibility patch no longer matches upstream Nextcloud ${nextcloudVersion} in ${patch.file}. Review the patch before packaging.`);
    }
    await writeFile(target, source.replace(patch.from, patch.to), "utf8");
    console.log(`[lasso-nextcloud] applied Windows compatibility patch to ${patch.file}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function versionedAssetName(version, platform, archiveType) {
  return `lasso-nextcloud-${version}-${platform}.${archiveType === "zip" ? "zip" : "tar.gz"}`;
}

async function download(url, destination) {
  if (existsSync(destination)) {
    const info = await stat(destination);
    if (info.size > 0) {
      return;
    }
  }

  const response = await fetch(url, {
    headers: {
      "user-agent": "service-lasso-lasso-nextcloud-packager",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
}

function extract(archive, destination, format) {
  const args = format === "zip"
    ? ["-xf", archive, "-C", destination]
    : format === "tar.bz2"
      ? ["-xjf", archive, "-C", destination]
      : ["-xzf", archive, "-C", destination];
  run("tar", args);
}

function inferArchiveFormat(archive) {
  const lower = archive.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "tar.bz2";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  throw new Error(`Cannot infer archive format from "${archive}". Set NEXTCLOUD_FORK_SERVER_FORMAT to zip, tar.gz or tar.bz2.`);
}

async function findFile(root, names) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(entryPath, names);
      if (nested) return nested;
    } else if (names.includes(entry.name.toLowerCase())) {
      return entryPath;
    }
  }
  return null;
}

async function compressPackage(packageRoot, outputPath, archiveType) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });

  if (archiveType === "zip") {
    // bsdtar's auto-compress flag produces a standard zip far faster than
    // Compress-Archive for the ~15k-file Nextcloud tree.
    run("tar", ["-a", "-cf", outputPath, "-C", packageRoot, "."]);
    return outputPath;
  }

  run("tar", ["-czf", outputPath, "-C", packageRoot, "."]);
  return outputPath;
}

export async function packageNextcloud(platform = targetPlatform, version = nextcloudVersion, php = phpVersion) {
  const target = targets[platform];
  if (!target) {
    throw new Error(`Unsupported target platform: ${platform}. Supported platforms: ${Object.keys(targets).join(", ")}.`);
  }

  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected Nextcloud version like "34.0.4", got "${version}".`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(php)) {
    throw new Error(`Expected PHP version like "8.3.32", got "${php}".`);
  }

  const vendorRoot = path.join(repoRoot, "vendor", version, platform);
  const outputRoot = path.join(repoRoot, "output", "package", version, platform);
  const packageRoot = path.join(outputRoot, "payload");
  const phpRoot = path.join(packageRoot, "php");
  const nextcloudRoot = path.join(packageRoot, "nextcloud");
  const nextcloudArchive = process.env.NEXTCLOUD_VENDOR_ARCHIVE
    ? path.resolve(process.env.NEXTCLOUD_VENDOR_ARCHIVE)
    : path.join(vendorRoot, target.nextcloud.asset);
  const phpArchive = path.join(vendorRoot, target.php.asset);
  const assetName = versionedAssetName(version, platform, target.archiveType);
  const outputPath = path.join(repoRoot, "dist", assetName);

  await mkdir(vendorRoot, { recursive: true });
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(phpRoot, { recursive: true });
  await mkdir(nextcloudRoot, { recursive: true });

  // A fork-hosted, prebuilt server archive (from service-lasso/fork-nextcloud-server)
  // can replace the upstream download. When used, the archive already carries the
  // platform compatibility patches, so none are applied here.
  const forkServerArchive = process.env.NEXTCLOUD_FORK_SERVER_ARCHIVE;
  let serverSource = "upstream";
  if (forkServerArchive) {
    serverSource = "fork";
    const format = process.env.NEXTCLOUD_FORK_SERVER_FORMAT ?? inferArchiveFormat(forkServerArchive);
    let archivePath;
    if (/^https?:\/\//i.test(forkServerArchive)) {
      archivePath = path.join(vendorRoot, `fork-nextcloud-server.${format}`);
      await download(forkServerArchive, archivePath);
    } else {
      archivePath = path.resolve(forkServerArchive);
    }
    if (!existsSync(archivePath)) {
      throw new Error(`NEXTCLOUD_FORK_SERVER_ARCHIVE was not found: ${archivePath}`);
    }
    extract(archivePath, packageRoot, format);
  } else {
    if (!process.env.NEXTCLOUD_VENDOR_ARCHIVE) {
      await download(target.nextcloud.url, nextcloudArchive);
    }
    extract(nextcloudArchive, packageRoot, target.nextcloud.format);
  }
  await download(target.php.url, phpArchive);
  extract(phpArchive, phpRoot, target.php.format);
  if (target.phpFpm) {
    const fpmArchive = path.join(vendorRoot, target.phpFpm.asset);
    await download(target.phpFpm.url, fpmArchive);
    extract(fpmArchive, phpRoot, target.phpFpm.format);
  }

  if (!existsSync(nextcloudRoot) || !existsSync(path.join(nextcloudRoot, "occ"))) {
    throw new Error(`Nextcloud occ entrypoint is missing under ${nextcloudRoot}.`);
  }

  if (serverSource === "upstream" && platform === "win32") {
    await applyWindowsCompatibilityPatches(nextcloudRoot);
  }

  // Bundle the OpenID Connect user backend so Nextcloud can authenticate
  // against the ZITADEL service in the same Service Lasso stack.
  const userOidcArchive = path.join(vendorRoot, `user_oidc-${userOidcVersion}.tar.gz`);
  await download(`https://github.com/nextcloud/user_oidc/archive/refs/tags/v${userOidcVersion}.tar.gz`, userOidcArchive);
  const userOidcExtract = path.join(outputRoot, "extract-user_oidc");
  await rm(userOidcExtract, { recursive: true, force: true });
  await mkdir(userOidcExtract, { recursive: true });
  extract(userOidcArchive, userOidcExtract, "tar.gz");
  const userOidcInner = (await readdir(userOidcExtract, { withFileTypes: true })).find((entry) => entry.isDirectory());
  if (!userOidcInner) {
    throw new Error("The user_oidc archive did not contain an application directory.");
  }
  await cp(path.join(userOidcExtract, userOidcInner.name), path.join(nextcloudRoot, "apps", "user_oidc"), { recursive: true });

  const phpBinary = await findFile(phpRoot, [platform === "win32" ? "php.exe" : "php"]);
  if (!phpBinary) {
    throw new Error(`Bundled PHP binary was not found under ${phpRoot} after extraction.`);
  }
  const expectedPhp = path.join(phpRoot, platform === "win32" ? "php.exe" : "php");
  if (path.normalize(phpBinary) !== path.normalize(expectedPhp)) {
    await cp(phpBinary, expectedPhp, { recursive: false });
  }

  await writeFile(path.join(packageRoot, "lasso-nextcloud.mjs"), await readFile(path.join(repoRoot, "runtime", "launcher.mjs"), "utf8"), "utf8");
  for (const helper of ["ensure-database.php", "configure.php", "occ.php"]) {
    await cp(path.join(repoRoot, "runtime", helper), path.join(packageRoot, helper));
  }
  await writeFile(path.join(packageRoot, "php.ini"), platform === "win32" ? phpIniWindows : phpIniCommon, "utf8");

  if (platform !== "win32") {
    await chmod(expectedPhp, 0o755);
    await chmod(path.join(packageRoot, "lasso-nextcloud.mjs"), 0o755);
    await chmod(path.join(nextcloudRoot, "occ"), 0o755);
  }

  await writeFile(
    path.join(packageRoot, "SERVICE-LASSO-PACKAGE.json"),
    `${JSON.stringify(
      {
        serviceId: "nextcloud",
        upstream: {
          vendor: "Nextcloud GmbH",
          source: "https://nextcloud.com/",
          version,
          asset: target.nextcloud.asset,
          url: target.nextcloud.url,
        },
        server: {
          source: serverSource,
          version,
          reference: process.env.NEXTCLOUD_FORK_SERVER_ARCHIVE ?? "",
        },
        php: {
          version: php,
          source: target.php.vendor,
          asset: target.php.asset,
          url: target.php.url,
        },
        packagedBy: "service-lasso/lasso-nextcloud",
        platform,
        arch: "x64",
        command: "node ./lasso-nextcloud.mjs",
        apps: [
          { id: "user_oidc", version: userOidcVersion, source: "https://github.com/nextcloud/user_oidc" },
        ],
        patches: serverSource === "upstream" && platform === "win32"
          ? windowsCompatibilityPatches.map(({ file, reason }) => ({ file, reason }))
          : [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await compressPackage(packageRoot, outputPath, target.archiveType);
  console.log(`[lasso-nextcloud] packaged ${outputPath}`);
  return outputPath;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packageNextcloud();
}
