<?php

/**
 * Create the Nextcloud database in the managed PostgreSQL dependency.
 *
 * The database server may still be starting when this service launches, so the
 * connection is retried for a bounded period. The database name is validated as
 * a simple identifier before it is quoted into DDL.
 */

[, $host, $port, $user, $password, $name] = $argv + [null, '127.0.0.1', '8500', 'pgadmin', 'pgadmin', 'nextcloud'];

if (!preg_match('/^[A-Za-z0-9_]+$/', (string) $name)) {
    fwrite(STDERR, "invalid database name: {$name}\n");
    exit(1);
}

$deadline = time() + 60;
$pdo = null;
do {
    try {
        $pdo = new PDO(
            "pgsql:host={$host};port={$port};dbname=postgres",
            $user,
            $password,
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 2]
        );
        break;
    } catch (Throwable $error) {
        if (time() >= $deadline) {
            fwrite(STDERR, "PostgreSQL was not reachable for database provisioning: {$error->getMessage()}\n");
            exit(1);
        }
        usleep(500000);
    }
} while (true);

$statement = $pdo->prepare('SELECT 1 FROM pg_database WHERE datname = ?');
$statement->execute([$name]);

if ($statement->fetchColumn() === false) {
    $pdo->exec('CREATE DATABASE "' . $name . '"');
    echo "created database {$name}\n";
} else {
    echo "database {$name} already exists\n";
}
