#!/usr/bin/env bash

set -euo pipefail

if (( $# != 5 )); then
  echo "Usage: $0 <next-build-dir> <output.tar.gz> <build-sha> <build-timestamp> <webpack|turbopack>" >&2
  exit 1
fi

NEXT_BUILD_DIR="$(cd "$1" && pwd)"
OUTPUT_PATH="$2"
BUILD_SHA="$3"
BUILD_TIMESTAMP="$4"
BUNDLER="$5"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_ROOT="$(cd "$NEXT_BUILD_DIR/.." && pwd)"
STANDALONE_ROOT="$NEXT_BUILD_DIR/standalone"
PACKAGE_LOCK="$FRONTEND_ROOT/package-lock.json"

case "$BUNDLER" in
  webpack|turbopack)
    ;;
  *)
    echo "Unsupported frontend bundler: $BUNDLER" >&2
    exit 1
    ;;
esac

if [[ ! "$BUILD_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "Build SHA must be a 40-character Git SHA." >&2
  exit 1
fi

test -f "$NEXT_BUILD_DIR/BUILD_ID"
test -d "$NEXT_BUILD_DIR/static"
test -f "$STANDALONE_ROOT/server.js"
test -f "$PACKAGE_LOCK"

OUTPUT_DIRECTORY="$(cd "$(dirname "$OUTPUT_PATH")" && pwd)"
OUTPUT_PATH="$OUTPUT_DIRECTORY/$(basename "$OUTPUT_PATH")"
STAGING_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "$STAGING_ROOT"
}
trap cleanup EXIT

cp -a "$STANDALONE_ROOT/." "$STAGING_ROOT/"
rm -rf "$STAGING_ROOT/.next/static" "$STAGING_ROOT/.next/cache"
mkdir -p "$STAGING_ROOT/.next"
cp -a "$NEXT_BUILD_DIR/static" "$STAGING_ROOT/.next/static"
if [[ -d "$FRONTEND_ROOT/public" ]]; then
  rm -rf "$STAGING_ROOT/public"
  cp -a "$FRONTEND_ROOT/public" "$STAGING_ROOT/public"
fi
rm -rf "$STAGING_ROOT/tests"
rm -f \
  "$STAGING_ROOT/AGENTS.md" \
  "$STAGING_ROOT/CLAUDE.md" \
  "$STAGING_ROOT/Dockerfile" \
  "$STAGING_ROOT/Dockerfile.dev" \
  "$STAGING_ROOT/README.md" \
  "$STAGING_ROOT/components.json" \
  "$STAGING_ROOT/eslint.config.mjs" \
  "$STAGING_ROOT/package-lock.json" \
  "$STAGING_ROOT/postcss.config.mjs" \
  "$STAGING_ROOT/tsconfig.json" \
  "$STAGING_ROOT/tsconfig.tsbuildinfo"

node "$SCRIPT_DIR/repair-next-runtime-artifacts.mjs" "$STAGING_ROOT" ".next"

for repaired_path in \
  "server/middleware-manifest.json" \
  "server/pages/500.html"; do
  if [[ -f "$NEXT_BUILD_DIR/$repaired_path" ]]; then
    mkdir -p "$STAGING_ROOT/.next/$(dirname "$repaired_path")"
    cp -a "$NEXT_BUILD_DIR/$repaired_path" "$STAGING_ROOT/.next/$repaired_path"
  fi
done

PACKAGE_LOCK_SHA256="$(sha256sum "$PACKAGE_LOCK" | awk '{print $1}')"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
BUILD_ID="$(tr -d '\r\n' <"$NEXT_BUILD_DIR/BUILD_ID")"
NEXT_VERSION="$(node -p 'require(process.argv[1]).version' "$STAGING_ROOT/node_modules/next/package.json")"
BUILD_PLATFORM="$(node -p 'process.platform')"
BUILD_ARCH="$(node -p 'process.arch')"
BUILD_LIBC="$(node -p 'process.report?.getReport()?.header?.glibcVersionRuntime || (process.platform === "linux" ? "unknown" : "not-applicable")')"

BUILD_SHA="$BUILD_SHA" \
BUILD_TIMESTAMP="$BUILD_TIMESTAMP" \
BUNDLER="$BUNDLER" \
PACKAGE_LOCK_SHA256="$PACKAGE_LOCK_SHA256" \
NODE_MAJOR="$NODE_MAJOR" \
BUILD_ID="$BUILD_ID" \
NEXT_VERSION="$NEXT_VERSION" \
BUILD_PLATFORM="$BUILD_PLATFORM" \
BUILD_ARCH="$BUILD_ARCH" \
BUILD_LIBC="$BUILD_LIBC" \
node --input-type=module - "$STAGING_ROOT/deployment-manifest.json" <<'NODE'
import { writeFile } from "node:fs/promises";

const manifest = {
  schema_version: 2,
  runtime_layout: "next-standalone",
  build_sha: process.env.BUILD_SHA,
  build_timestamp: process.env.BUILD_TIMESTAMP,
  bundler: process.env.BUNDLER,
  node_major: Number(process.env.NODE_MAJOR),
  next_version: process.env.NEXT_VERSION,
  platform: process.env.BUILD_PLATFORM,
  arch: process.env.BUILD_ARCH,
  libc: process.env.BUILD_LIBC,
  package_lock_sha256: process.env.PACKAGE_LOCK_SHA256,
  build_id: process.env.BUILD_ID,
  entrypoint: "server.js",
  dist_dir: ".next",
  public_environment: {
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL?.trim() || "https://api.cred-x.in",
    NEXT_PUBLIC_FRONTEND_URL:
      process.env.NEXT_PUBLIC_FRONTEND_URL?.trim() || "https://cred-x.in",
    NEXT_PUBLIC_BRAND_PREFIX:
      process.env.NEXT_PUBLIC_BRAND_PREFIX?.trim() || "Cred-X",
    NEXT_PUBLIC_BRAND_ACRONYM:
      process.env.NEXT_PUBLIC_BRAND_ACRONYM?.trim() || "TIE",
    NEXT_PUBLIC_BRAND_EXPANSION:
      process.env.NEXT_PUBLIC_BRAND_EXPANSION?.trim() ||
      "Tarun's Investment Engine",
    NEXT_PUBLIC_DISABLE_AUTH:
      process.env.NEXT_PUBLIC_DISABLE_AUTH?.trim() || "false",
    NEXT_PUBLIC_DISABLE_API_PROXY:
      process.env.NEXT_PUBLIC_DISABLE_API_PROXY?.trim() || "false",
    NEXT_PUBLIC_API_DEBUG:
      process.env.NEXT_PUBLIC_API_DEBUG?.trim() || "false",
  },
};

await writeFile(process.argv[2], `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
NODE

node "$SCRIPT_DIR/frontend-artifact.mjs" validate "$STAGING_ROOT" "$BUILD_SHA" >/dev/null

mkdir -p "$OUTPUT_DIRECTORY"
rm -f "$OUTPUT_PATH" "$OUTPUT_PATH.sha256"
COPYFILE_DISABLE=1 tar -C "$STAGING_ROOT" -czf "$OUTPUT_PATH" .
(
  cd "$OUTPUT_DIRECTORY"
  sha256sum "$(basename "$OUTPUT_PATH")" >"$(basename "$OUTPUT_PATH").sha256"
)

echo "Frontend artifact: $OUTPUT_PATH"
du -h "$OUTPUT_PATH"
