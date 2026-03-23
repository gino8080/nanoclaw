#!/bin/bash
# Git credential helper that reads tokens from GIT_CREDENTIALS env var.
# GIT_CREDENTIALS is a JSON array: [{"host":"github.com","token":"xxx"}, ...]
# This script is called by git with "get" as the first argument.

if [ "$1" != "get" ]; then
  exit 0
fi

if [ -z "$GIT_CREDENTIALS" ]; then
  exit 0
fi

# Read the requested host from stdin
declare -A input
while IFS='=' read -r key value; do
  input["$key"]="$value"
done

host="${input[host]}"
if [ -z "$host" ]; then
  exit 0
fi

# Parse JSON and find matching token (using node for reliable JSON parsing)
token=$(node -e "
  try {
    const creds = JSON.parse(process.env.GIT_CREDENTIALS || '[]');
    const match = creds.find(c => '${host}'.includes(c.host));
    if (match) {
      console.log('protocol=https');
      console.log('host=${host}');
      console.log('username=oauth2');
      console.log('password=' + match.token);
    }
  } catch {}
" 2>/dev/null)

if [ -n "$token" ]; then
  echo "$token"
fi
