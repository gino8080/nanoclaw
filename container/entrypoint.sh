#!/bin/bash
set -e

# Shadow .env so the agent cannot read host secrets (requires root)
if [ "$(id -u)" = "0" ] && [ -f /workspace/project/.env ]; then
  mount --bind /dev/null /workspace/project/.env
fi

# Configure git credential helper for multi-host token auth
if [ -n "$GIT_CREDENTIALS" ]; then
  git config --global credential.helper nanoclaw
  git config --global user.name "NanoClaw"
  git config --global user.email "noreply@nanoclaw.dev"

  # Generate glab config for all GitLab instances
  node -e '
    const creds = JSON.parse(process.env.GIT_CREDENTIALS || "[]");
    const gitlabs = creds.filter(c => c.host.includes("gitlab"));
    if (gitlabs.length === 0) process.exit(0);

    const fs = require("fs");
    const path = require("path");
    const configDir = path.join(process.env.HOME || "/home/node", ".config", "glab-cli");
    fs.mkdirSync(configDir, { recursive: true });

    let yaml = "hosts:\n";
    for (const gl of gitlabs) {
      yaml += "  https://" + gl.host + ":\n";
      yaml += "    token: " + gl.token + "\n";
      yaml += "    api_host: " + gl.host + "\n";
      yaml += "    git_protocol: https\n";
    }

    fs.writeFileSync(path.join(configDir, "config.yml"), yaml);
  ' 2>/dev/null || true
fi

# Compile agent-runner
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Capture stdin (secrets JSON) to temp file
cat > /tmp/input.json

# Drop privileges if running as root (main-group containers)
if [ "$(id -u)" = "0" ] && [ -n "$RUN_UID" ]; then
  chown "$RUN_UID:$RUN_GID" /tmp/input.json /tmp/dist
  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups -- node /tmp/dist/index.js < /tmp/input.json
fi

exec node /tmp/dist/index.js < /tmp/input.json
