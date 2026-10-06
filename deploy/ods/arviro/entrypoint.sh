#!/bin/sh
# Container entry point: prepare /data/config.json from the environment, then run the server.
set -eu
ARVIRO_HOME="${ARVIRO_HOME:-/opt/arviro}"
node "${ARVIRO_HOME}/deploy/ods/arviro/prepare-config.mjs"
exec node "${ARVIRO_HOME}/bin/arviro.js" serve --config "${ARVIRO_DATA:-/data}/config.json"
