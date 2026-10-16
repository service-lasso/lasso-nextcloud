<?php

/**
 * Reconcile deployment-local Nextcloud settings after install or upgrade.
 *
 * Nextcloud runs as a FastCGI backend behind an external front (lasso-caddy).
 * This writes the trusted domains, the writable custom-apps path and the public
 * CLI URL; the front-end's Host header is honoured. Retained configuration
 * written by Nextcloud itself is preserved.
 */

[, $appsDir] = $argv + [null, null];

$configDir = getenv('NEXTCLOUD_CONFIG_DIR');
if ($configDir === false || $configDir === '') {
    $configDir = __DIR__ . '/config';
}

$configFile = rtrim($configDir, "/\\") . '/config.php';
if (!is_file($configFile)) {
    fwrite(STDERR, "config.php not found: {$configFile}\n");
    exit(1);
}

$returned = include $configFile;
if (is_array($returned)) {
    $config = $returned;
} elseif (isset($CONFIG) && is_array($CONFIG)) {
    $config = $CONFIG;
} else {
    fwrite(STDERR, "config.php did not provide a configuration array\n");
    exit(1);
}

$nextcloudRoot = __DIR__ . '/nextcloud';
// Use native separators so the values match realpath() during Nextcloud's
// symlink containment checks (mixed separators fail on Windows).
$native = static fn (string $value): string => str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $value);

$trusted = ['localhost', '127.0.0.1'];
foreach (explode(',', (string) getenv('NEXTCLOUD_TRUSTED_DOMAINS')) as $domain) {
    $domain = trim($domain);
    if ($domain !== '') {
        $trusted[] = $domain;
    }
}
foreach (($config['trusted_domains'] ?? []) as $domain) {
    $trusted[] = $domain;
}
$config['trusted_domains'] = array_values(array_unique($trusted));

if (is_string($appsDir) && $appsDir !== '') {
    $config['apps_paths'] = [
        ['path' => $native($nextcloudRoot . '/apps'), 'url' => '/apps', 'writable' => false],
        ['path' => $native($appsDir), 'url' => '/custom_apps', 'writable' => true],
    ];
}

if (PHP_OS_FAMILY === 'Windows') {
    // Nextcloud's POSIX permission model cannot be satisfied on Windows.
    $config['check_data_directory_permissions'] = false;
}

// Local-first service: do not block requests on app-store, update or
// well-known connectivity checks.
$config['appstoreenabled'] = false;
$config['has_internet_connection'] = false;
$config['updatechecker'] = false;
$config['check_for_working_wellknown_setup'] = false;

// The external front (lasso-caddy) supplies the real Host header, so the
// overwrite host/protocol are cleared. A public URL can still pin the CLI URL.
unset($config['overwritehost'], $config['overwriteprotocol']);
$publicUrl = trim((string) getenv('NEXTCLOUD_PUBLIC_URL'));
if ($publicUrl !== '') {
    $config['overwrite.cli.url'] = rtrim($publicUrl, '/');
}

$dataDir = getenv('NEXTCLOUD_DATA_DIR');
if (is_string($dataDir) && $dataDir !== '') {
    $config['datadirectory'] = $native($dataDir);
}

file_put_contents($configFile, "<?php\n\$CONFIG = " . var_export($config, true) . ";\n");
echo "configured Nextcloud as a FastCGI backend\n";
