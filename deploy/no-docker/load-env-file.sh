#!/usr/bin/env bash

# Load a systemd-style EnvironmentFile without evaluating its values as shell
# code. Production secrets may legitimately contain spaces or shell metacharacters.
load_env_file() {
  local file="$1"
  local line key value

  if [[ ! -f "$file" ]]; then
    echo "Environment file not found: $file" >&2
    return 1
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]]; then
      continue
    fi
    if [[ ! "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      echo "Invalid environment assignment in $file" >&2
      return 1
    fi

    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if (( ${#value} >= 2 )) && [[
      ( "${value:0:1}" == "'" && "${value: -1}" == "'" ) ||
      ( "${value:0:1}" == '"' && "${value: -1}" == '"' )
    ]]; then
      value="${value:1:${#value}-2}"
    fi

    printf -v "$key" '%s' "$value"
    export "$key"
  done <"$file"
}
