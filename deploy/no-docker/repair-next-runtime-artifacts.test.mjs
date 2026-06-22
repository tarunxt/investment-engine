import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL("./repair-next-runtime-artifacts.mjs", import.meta.url),
);

async function runRepair(projectRoot) {
  return execFileAsync(process.execPath, [scriptPath, projectRoot], {
    cwd: projectRoot,
  });
}

test("repair-next-runtime-artifacts recreates missing runtime files", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "next-runtime-artifacts-"));
  const nestedManifestPath = path.join(
    projectRoot,
    ".next",
    "server",
    "middleware",
    "middleware-manifest.json",
  );

  await mkdir(path.dirname(nestedManifestPath), { recursive: true });
  await writeFile(
    path.join(projectRoot, "middleware.ts"),
    "export default function middleware() {}\n",
    "utf8",
  );
  await writeFile(
    nestedManifestPath,
    JSON.stringify(
      {
        sorted_middleware: ["/"],
        middleware: {
          "/": {
            files: ["server/edge/chunks/middleware.js"],
            name: "middleware",
            page: "/",
            entrypoint: "server/edge/chunks/middleware.js",
            matchers: [{ regexp: "/login", originalSource: "/login" }],
            wasm: [],
            assets: [],
            env: {},
          },
        },
        functions: {},
      },
      null,
      2,
    ),
    "utf8",
  );

  const { stdout } = await runRepair(projectRoot);
  assert.match(stdout, /Repaired Next runtime artifacts:/);

  const rootManifest = JSON.parse(
    await readFile(
      path.join(projectRoot, ".next", "server", "middleware-manifest.json"),
      "utf8",
    ),
  );
  assert.equal(rootManifest.version, 3);
  assert.deepEqual(rootManifest.sortedMiddleware, ["/"]);
  assert.ok(rootManifest.middleware["/"]);

  const errorPage = await readFile(
    path.join(projectRoot, ".next", "server", "pages", "500.html"),
    "utf8",
  );
  assert.match(errorPage, /Internal Server Error/);
});

test("repair-next-runtime-artifacts preserves existing files", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "next-runtime-artifacts-"));
  const rootManifestPath = path.join(
    projectRoot,
    ".next",
    "server",
    "middleware-manifest.json",
  );
  const errorPagePath = path.join(
    projectRoot,
    ".next",
    "server",
    "pages",
    "500.html",
  );

  await mkdir(path.dirname(rootManifestPath), { recursive: true });
  await mkdir(path.dirname(errorPagePath), { recursive: true });
  await writeFile(rootManifestPath, '{"version":3,"middleware":{},"sortedMiddleware":[],"functions":{}}\n', "utf8");
  await writeFile(errorPagePath, "custom-500", "utf8");

  const { stdout } = await runRepair(projectRoot);
  assert.match(stdout, /already present/);
  assert.equal(await readFile(rootManifestPath, "utf8"), '{"version":3,"middleware":{},"sortedMiddleware":[],"functions":{}}\n');
  assert.equal(await readFile(errorPagePath, "utf8"), "custom-500");
});
