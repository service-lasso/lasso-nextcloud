<?php

/**
 * Cross-platform Nextcloud occ entrypoint.
 *
 * The Nextcloud occ script calls posix_getuid() while dropping privileges when
 * run as root. The POSIX extension is not available on Windows PHP, so the
 * required functions are shimmed for non-POSIX platforms before occ runs.
 * occ's privilege drop is a no-op off POSIX because the shim never reports uid 0.
 */

if (!function_exists('posix_getuid')) {
    // PHP on Windows reports 0 as fileowner(); matching it satisfies occ's
    // "same user as config.php" guard. dropPrivileges() then resolves the
    // bundled config path, which has no owner, and returns without setuid.
    function posix_getuid()
    {
        return 0;
    }
}
if (!function_exists('posix_geteuid')) {
    function posix_geteuid()
    {
        return 0;
    }
}
if (!function_exists('posix_getpwuid')) {
    function posix_getpwuid($uid)
    {
        return false;
    }
}
if (!function_exists('posix_setuid')) {
    function posix_setuid($uid)
    {
        return false;
    }
}
if (!function_exists('posix_setgid')) {
    function posix_setgid($gid)
    {
        return false;
    }
}

require __DIR__ . '/nextcloud/occ';
