#!/bin/sh
set -eu
umask 077
node /app/deploy/studio/check-runtime.mjs
exec node /app/studio/bff/image-server.mjs
