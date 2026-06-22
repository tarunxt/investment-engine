#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function buildFallback500Html() {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Internal Server Error</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f8fafc;
        color: #0f172a;
      }
      main {
        width: min(32rem, calc(100vw - 2rem));
        padding: 2rem;
        border-radius: 1rem;
        background: white;
        box-shadow: 0 20px 45px rgba(15, 23, 42, 0.08);
        text-align: center;
      }
      h1 {
        margin: 0 0 0.75rem;
        font-size: 1.75rem;
      }
      p {
        margin: 0;
        color: #475569;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Internal Server Error</h1>
      <p>The application hit an unexpected error. Please try again shortly.</p>
    </main>
  </body>
</html>
`;
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function ensureLegacyMiddlewareManifest(projectRoot) {
  const rootManifestPath = path.join(
    projectRoot,
    ".next",
    "server",
    "middleware-manifest.json",
  );
  if (await pathExists(rootManifestPath)) {
    return null;
  }

  const nestedManifestPath = path.join(
    projectRoot,
    ".next",
    "server",
    "middleware",
    "middleware-manifest.json",
  );
  if (!(await pathExists(nestedManifestPath))) {
    const hasProxyEntrypoint =
      (await pathExists(path.join(projectRoot, "middleware.ts"))) ||
      (await pathExists(path.join(projectRoot, "middleware.js"))) ||
      (await pathExists(path.join(projectRoot, "proxy.ts"))) ||
      (await pathExists(path.join(projectRoot, "proxy.js")));

    if (hasProxyEntrypoint) {
      throw new Error(
        "Next runtime is missing both middleware manifest files even though middleware/proxy exists.",
      );
    }

    return null;
  }

  const nestedManifest = JSON.parse(await readFile(nestedManifestPath, "utf8"));
  const normalizedManifest = {
    version: 3,
    middleware: nestedManifest.middleware ?? {},
    sortedMiddleware: Array.isArray(nestedManifest.sortedMiddleware)
      ? nestedManifest.sortedMiddleware
      : Array.isArray(nestedManifest.sorted_middleware)
        ? nestedManifest.sorted_middleware
        : Object.keys(nestedManifest.middleware ?? {}).sort(),
    functions: nestedManifest.functions ?? {},
  };

  await writeFile(
    rootManifestPath,
    `${JSON.stringify(normalizedManifest, null, 2)}\n`,
    "utf8",
  );

  return rootManifestPath;
}

async function ensureFallback500Page(projectRoot) {
  const errorPagePath = path.join(projectRoot, ".next", "server", "pages", "500.html");
  if (await pathExists(errorPagePath)) {
    return null;
  }

  await mkdir(path.dirname(errorPagePath), { recursive: true });
  await writeFile(errorPagePath, buildFallback500Html(), "utf8");
  return errorPagePath;
}

async function main() {
  const projectRoot = path.resolve(process.argv[2] || process.cwd());
  const repairedPaths = [];

  const manifestPath = await ensureLegacyMiddlewareManifest(projectRoot);
  if (manifestPath) repairedPaths.push(path.relative(projectRoot, manifestPath));

  const errorPagePath = await ensureFallback500Page(projectRoot);
  if (errorPagePath) repairedPaths.push(path.relative(projectRoot, errorPagePath));

  if (repairedPaths.length > 0) {
    console.log(
      `Repaired Next runtime artifacts: ${repairedPaths.join(", ")}`,
    );
  } else {
    console.log("Next runtime artifacts already present");
  }
}

main().catch((error) => {
  console.error(
    `Failed to repair Next runtime artifacts: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
