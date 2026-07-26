#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const FRONTEND_PREFIX = "frontend/";
const BACKEND_PREFIX = "backend/";

const FULL_STACK_PATHS = new Set([
  ".env.prod.example",
  "docker-compose.prod.yml",
  "docker-compose.yml",
]);

const FULL_STACK_PREFIXES = [
  ".github/workflows/",
  "deploy/",
  "scripts/",
];

const SCOPE_COMPONENTS = new Map([
  ["none", new Set()],
  ["frontend-only", new Set(["frontend"])],
  ["backend-only", new Set(["backend"])],
  ["full-stack", new Set(["frontend", "backend"])],
]);

function normalizePath(value) {
  return value.trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
}

export function combineDeploymentScopes(left, right) {
  const leftComponents = SCOPE_COMPONENTS.get(left);
  const rightComponents = SCOPE_COMPONENTS.get(right);
  if (!leftComponents || !rightComponents) {
    throw new Error(`Cannot combine deployment scopes: ${left}, ${right}`);
  }

  const combined = new Set([...leftComponents, ...rightComponents]);
  if (combined.has("frontend") && combined.has("backend")) {
    return "full-stack";
  }
  if (combined.has("frontend")) {
    return "frontend-only";
  }
  if (combined.has("backend")) {
    return "backend-only";
  }
  return "none";
}

export function classifyDeploymentScope(paths) {
  const changedPaths = [...new Set(paths.map(normalizePath).filter(Boolean))];
  if (changedPaths.length === 0) {
    return "none";
  }

  let frontendChanged = false;
  let backendChanged = false;

  for (const path of changedPaths) {
    if (
      FULL_STACK_PATHS.has(path) ||
      FULL_STACK_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
      path.endsWith(".env.example")
    ) {
      return "full-stack";
    }

    if (path.startsWith(FRONTEND_PREFIX)) {
      frontendChanged = true;
      continue;
    }

    if (path.startsWith(BACKEND_PREFIX)) {
      backendChanged = true;
    }
  }

  if (frontendChanged && backendChanged) {
    return "full-stack";
  }
  if (frontendChanged) {
    return "frontend-only";
  }
  if (backendChanged) {
    return "backend-only";
  }
  return "none";
}

async function readChangedPaths(args) {
  const nullDelimited = args.includes("--null");
  const fileIndex = args.indexOf("--file");
  const input =
    fileIndex >= 0
      ? await readFile(args[fileIndex + 1])
      : await new Promise((resolve, reject) => {
          const chunks = [];
          process.stdin.on("data", (chunk) => chunks.push(chunk));
          process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
          process.stdin.on("error", reject);
        });

  return input
    .toString("utf8")
    .split(nullDelimited ? "\0" : /\r?\n/)
    .filter(Boolean);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--combine") {
    process.stdout.write(`${combineDeploymentScopes(args[1], args[2])}\n`);
    return;
  }
  const paths = await readChangedPaths(args);
  process.stdout.write(`${classifyDeploymentScope(paths)}\n`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
