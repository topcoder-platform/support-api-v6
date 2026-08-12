#!/bin/sh
set -eu

printf '%s\n' 'Applying support database migrations.'
./node_modules/.bin/prisma migrate deploy

printf '%s\n' 'Starting Support API v6.'
exec node dist/main.js
