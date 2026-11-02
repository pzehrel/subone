#!/bin/sh
set -e

# If /app/templates is empty (e.g. shadowed by an empty host bind mount), populate with defaults
mkdir -p /app/data /app/templates
if [ ! -e /app/config.json ] && [ ! -L /app/config.json ]; then
  ln -s /app/data/server-config.json /app/config.json
fi
if [ -d /app/templates.default ] && [ -z "$(ls -A /app/templates)" ]; then
  cp -R /app/templates.default/. /app/templates/
fi

if [ "$(id -u)" = "0" ]; then
  chown node:node /app
  chown -R node:node /app/data /app/templates
  if [ -f /app/config.json ]; then
    chown node:node /app/config.json
  fi
  exec su-exec node:node "$@"
fi

exec "$@"
