#!/bin/bash
# ---------------------------------------------------------------------------
# Runs ONCE, on first container initialisation only (when the mysql-data
# volume is empty). Re-running it means: docker compose down -v.
#
# This is a .sh rather than a .sql file on purpose: the MySQL entrypoint pipes
# .sql files straight into the client with NO variable substitution, so a .sql
# file would have to hard-code the database and user names. A shell script can
# read them from the environment, which is what keeps credentials in .env.
#
# What this guarantees:
#   1. Both `marketplace` and `marketplace_shadow` exist, with the same
#      charset/collation Prisma emits in its migrations.
#   2. A DEDICATED application user (never root) holds full privileges on
#      BOTH databases.
#   3. That user needs NO global CREATE DATABASE privilege, because the shadow
#      database already exists — which is exactly why `prisma migrate dev`
#      can run without elevated rights on the main application database.
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DB="${MYSQL_DATABASE:-marketplace}"
SHADOW_DB="${MYSQL_SHADOW_DATABASE:-marketplace_shadow}"
APP_USER="${MYSQL_USER:?MYSQL_USER must be set}"
APP_PASSWORD="${MYSQL_PASSWORD:?MYSQL_PASSWORD must be set}"

echo "[init] app database    : ${APP_DB}"
echo "[init] shadow database : ${SHADOW_DB}"
echo "[init] application user: ${APP_USER}"

# --protocol=socket keeps this on the local unix socket, so the root password
# never travels over TCP.
mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" <<-EOSQL
	CREATE DATABASE IF NOT EXISTS \`${APP_DB}\`
	  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

	CREATE DATABASE IF NOT EXISTS \`${SHADOW_DB}\`
	  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

	CREATE USER IF NOT EXISTS '${APP_USER}'@'%'
	  IDENTIFIED BY '${APP_PASSWORD}';

	-- ALL PRIVILEGES scoped to these two schemas only. This covers everything
	-- Prisma Migrate needs (CREATE/ALTER/DROP TABLE, INDEX, REFERENCES) while
	-- granting nothing server-wide.
	GRANT ALL PRIVILEGES ON \`${APP_DB}\`.*    TO '${APP_USER}'@'%';
	GRANT ALL PRIVILEGES ON \`${SHADOW_DB}\`.* TO '${APP_USER}'@'%';

	FLUSH PRIVILEGES;
EOSQL

echo "[init] done: '${APP_USER}' has full privileges on ${APP_DB} and ${SHADOW_DB}"
