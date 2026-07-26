import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  selectBuildSlots,
  validateArtifactDirectory,
  writeActiveBuildPointer,
} from "./frontend-artifact.mjs";

const execFileAsync = promisify(execFile);
const packageScript = fileURLToPath(
  new URL("./package-frontend-artifact.sh", import.meta.url),
);
const buildSha = "0123456789abcdef0123456789abcdef01234567";

async function createRuntimeSlot(slotPath, marker) {
  await mkdir(path.join(slotPath, ".next", "static"), { recursive: true });
  await mkdir(path.join(slotPath, ".next", "server", "pages"), {
    recursive: true,
  });
  await mkdir(path.join(slotPath, "node_modules", "next"), { recursive: true });
  await writeFile(path.join(slotPath, "server.js"), "// standalone\n");
  await writeFile(path.join(slotPath, "package.json"), '{"type":"commonjs"}\n');
  await writeFile(
    path.join(slotPath, "node_modules", "next", "package.json"),
    '{"version":"16.2.5"}\n',
  );
  await writeFile(path.join(slotPath, ".next", "BUILD_ID"), `${marker}\n`);
  await writeFile(
    path.join(slotPath, ".next", "static", `${marker}.js`),
    "console.log('ok')\n",
  );
  await writeFile(
    path.join(slotPath, ".next", "static", `${marker}.css`),
    "body{}\n",
  );
  await writeFile(
    path.join(slotPath, ".next", "required-server-files.json"),
    '{"version":1,"config":{},"files":[]}\n',
  );
  await writeFile(
    path.join(slotPath, ".next", "server", "app-paths-manifest.json"),
    `${JSON.stringify({
      "/(auth)/login/page": "app/login.js",
      "/api/auth/[...nextauth]/route": "app/auth.js",
      "/api/runtime-fingerprint/route": "app/fingerprint.js",
      "/backend-api/[...path]/route": "app/proxy.js",
      "/console/dashboard/page": "app/dashboard.js",
      "/console/bullpen-ai/page": "app/bullpen.js",
    })}\n`,
  );
  await writeFile(
    path.join(slotPath, ".next", "server", "functions-config-manifest.json"),
    '{"version":1,"functions":{}}\n',
  );
  await writeFile(
    path.join(slotPath, ".next", "server", "middleware-manifest.json"),
    '{"version":3,"middleware":{},"sortedMiddleware":[],"functions":{}}\n',
  );
  await writeFile(
    path.join(slotPath, ".next", "server", "pages", "500.html"),
    "error\n",
  );
}

test("selects the inactive slot opposite the atomic active pointer", async () => {
  const frontendRoot = await mkdtemp(path.join(tmpdir(), "frontend-slots-"));
  assert.deepEqual(await selectBuildSlots(frontendRoot), {
    active: ".next",
    inactive: ".next-candidate",
  });

  await writeFile(
    path.join(frontendRoot, ".next-active-dir"),
    ".next-candidate\n",
  );
  assert.deepEqual(await selectBuildSlots(frontendRoot), {
    active: ".next-candidate",
    inactive: ".next",
  });
});

test("rejects a malformed active build pointer", async () => {
  const frontendRoot = await mkdtemp(path.join(tmpdir(), "frontend-slots-"));
  await writeFile(
    path.join(frontendRoot, ".next-active-dir"),
    "../../active-build\n",
  );
  await assert.rejects(
    selectBuildSlots(frontendRoot),
    /Invalid frontend build slot/,
  );
});

test("restores the previous pointer after candidate verification fails", async () => {
  const frontendRoot = await mkdtemp(path.join(tmpdir(), "frontend-rollback-"));
  await createRuntimeSlot(path.join(frontendRoot, ".next"), "previous");
  await createRuntimeSlot(
    path.join(frontendRoot, ".next-candidate"),
    "candidate",
  );

  await writeActiveBuildPointer(frontendRoot, ".next-candidate");
  assert.equal(
    (await readFile(path.join(frontendRoot, ".next-active-dir"), "utf8")).trim(),
    ".next-candidate",
  );

  const candidateVerificationPassed = false;
  if (!candidateVerificationPassed) {
    await writeActiveBuildPointer(frontendRoot, ".next");
  }

  assert.equal(
    (await readFile(path.join(frontendRoot, ".next-active-dir"), "utf8")).trim(),
    ".next",
  );
  assert.equal(
    (await readFile(path.join(frontendRoot, ".next", ".next", "BUILD_ID"), "utf8")).trim(),
    "previous",
  );
});

test("packages only the standalone runtime and excludes the reusable build cache", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "frontend-package-"));
  const buildRoot = path.join(projectRoot, ".next");
  const standaloneRoot = path.join(buildRoot, "standalone");
  const outputPath = path.join(projectRoot, "frontend-runtime.tar.gz");
  const extractedRoot = path.join(projectRoot, "extracted");

  await mkdir(path.join(buildRoot, "static"), { recursive: true });
  await mkdir(path.join(buildRoot, "cache"), { recursive: true });
  await mkdir(path.join(standaloneRoot, ".next", "server", "pages"), {
    recursive: true,
  });
  await mkdir(path.join(standaloneRoot, "node_modules", "next"), {
    recursive: true,
  });
  await mkdir(path.join(standaloneRoot, "public"), { recursive: true });
  await mkdir(path.join(standaloneRoot, "tests"), { recursive: true });
  await mkdir(path.join(projectRoot, "public"), { recursive: true });
  await writeFile(path.join(projectRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
  await writeFile(path.join(buildRoot, "BUILD_ID"), "build-id\n");
  await writeFile(path.join(buildRoot, "static", "app.js"), "console.log('ok')\n");
  await writeFile(path.join(buildRoot, "static", "app.css"), "body{}\n");
  await writeFile(path.join(buildRoot, "cache", "expensive-cache"), "not deployable\n");
  await writeFile(path.join(standaloneRoot, "server.js"), "// standalone\n");
  await writeFile(
    path.join(standaloneRoot, "public", "stale-public-file"),
    "must be replaced\n",
  );
  await writeFile(
    path.join(standaloneRoot, "tests", "not-runtime.test.mjs"),
    "throw new Error('must not deploy')\n",
  );
  await writeFile(path.join(standaloneRoot, "package.json"), '{"type":"commonjs"}\n');
  await writeFile(
    path.join(standaloneRoot, "node_modules", "next", "package.json"),
    '{"version":"16.2.5"}\n',
  );
  await writeFile(path.join(standaloneRoot, ".next", "BUILD_ID"), "build-id\n");
  await writeFile(
    path.join(standaloneRoot, ".next", "required-server-files.json"),
    '{"version":1,"config":{},"files":[]}\n',
  );
  await writeFile(
    path.join(standaloneRoot, ".next", "server", "app-paths-manifest.json"),
    `${JSON.stringify({
      "/(auth)/login/page": "app/login.js",
      "/api/auth/[...nextauth]/route": "app/auth.js",
      "/api/runtime-fingerprint/route": "app/fingerprint.js",
      "/backend-api/[...path]/route": "app/proxy.js",
      "/console/dashboard/page": "app/dashboard.js",
      "/console/bullpen-ai/page": "app/bullpen.js",
    })}\n`,
  );
  await writeFile(
    path.join(standaloneRoot, ".next", "server", "functions-config-manifest.json"),
    '{"version":1,"functions":{}}\n',
  );
  await writeFile(
    path.join(standaloneRoot, ".next", "server", "middleware-manifest.json"),
    '{"version":3,"middleware":{},"sortedMiddleware":[],"functions":{}}\n',
  );
  await writeFile(
    path.join(standaloneRoot, ".next", "server", "required.js"),
    "export default true\n",
  );
  await writeFile(path.join(projectRoot, "public", "favicon.ico"), "icon\n");

  await execFileAsync(
    "bash",
    [
      packageScript,
      buildRoot,
      outputPath,
      buildSha,
      "2026-07-26T00:00:00Z",
      "webpack",
    ],
    { cwd: projectRoot },
  );
  await mkdir(extractedRoot);
  await execFileAsync("tar", ["-xzf", outputPath, "-C", extractedRoot]);

  const manifest = await validateArtifactDirectory(extractedRoot, {
    expectedBuildSha: buildSha,
  });
  assert.equal(manifest.bundler, "webpack");
  assert.equal(manifest.runtime_layout, "next-standalone");
  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.public_environment.NEXT_PUBLIC_DISABLE_AUTH, "false");
  await validateArtifactDirectory(extractedRoot, {
    allowedBundler: "webpack",
    expectedBuildSha: buildSha,
    expectedPackageLockSha256: manifest.package_lock_sha256,
    expectedPublicEnvironment: manifest.public_environment,
  });
  await assert.rejects(
    validateArtifactDirectory(extractedRoot, {
      allowedBundler: "turbopack",
      expectedBuildSha: buildSha,
    }),
    /bundler mismatch/,
  );
  await assert.rejects(
    validateArtifactDirectory(extractedRoot, {
      expectedBuildSha: buildSha,
      expectedPublicEnvironment: {
        ...manifest.public_environment,
        NEXT_PUBLIC_BRAND_PREFIX: "Unexpected",
      },
    }),
    /public build environment does not match/,
  );
  await assert.rejects(
    readFile(path.join(extractedRoot, ".next", "cache", "expensive-cache")),
    { code: "ENOENT" },
  );
  assert.equal(
    await readFile(path.join(extractedRoot, "public", "favicon.ico"), "utf8"),
    "icon\n",
  );
  await assert.rejects(
    readFile(path.join(extractedRoot, "public", "public", "favicon.ico")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    readFile(path.join(extractedRoot, "public", "stale-public-file")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    readFile(path.join(extractedRoot, "tests", "not-runtime.test.mjs")),
    { code: "ENOENT" },
  );
  assert.match(
    await readFile(`${outputPath}.sha256`, "utf8"),
    /^[0-9a-f]{64}\s+/,
  );
  await assert.rejects(
    validateArtifactDirectory(extractedRoot, {
      expectedBuildSha: "f".repeat(40),
    }),
    /build SHA mismatch/,
  );

  await mkdir(path.join(extractedRoot, ".next", "cache", "images"), {
    recursive: true,
  });
  await writeFile(
    path.join(extractedRoot, ".next", "cache", "images", "runtime-entry"),
    "runtime cache\n",
  );
  await assert.rejects(
    validateArtifactDirectory(extractedRoot),
    /must not contain the reusable build cache/,
  );
  await validateArtifactDirectory(extractedRoot, {
    allowRuntimeCache: true,
  });
});

test("rejects symlinks that escape the packaged runtime", async () => {
  const artifactRoot = await mkdtemp(path.join(tmpdir(), "frontend-artifact-"));
  await createRuntimeSlot(artifactRoot, "candidate");
  await writeFile(
    path.join(artifactRoot, "deployment-manifest.json"),
    JSON.stringify({
      schema_version: 2,
      runtime_layout: "next-standalone",
      build_sha: buildSha,
      build_timestamp: "2026-07-26T00:00:00Z",
      bundler: "webpack",
      node_major: 22,
      platform: process.platform,
      arch: process.arch,
      next_version: "16.2.5",
      package_lock_sha256: "a".repeat(64),
      build_id: "candidate",
      entrypoint: "server.js",
      dist_dir: ".next",
      public_environment: {
        NEXT_PUBLIC_API_URL: "https://api.cred-x.in",
        NEXT_PUBLIC_FRONTEND_URL: "https://cred-x.in",
        NEXT_PUBLIC_BRAND_PREFIX: "Cred-X",
        NEXT_PUBLIC_BRAND_ACRONYM: "TIE",
        NEXT_PUBLIC_BRAND_EXPANSION: "Tarun's Investment Engine",
        NEXT_PUBLIC_DISABLE_AUTH: "false",
        NEXT_PUBLIC_DISABLE_API_PROXY: "false",
        NEXT_PUBLIC_API_DEBUG: "false",
      },
    }),
  );
  await symlink("/tmp", path.join(artifactRoot, "escaping-link"));

  await assert.rejects(
    validateArtifactDirectory(artifactRoot, { expectedBuildSha: buildSha }),
    /escapes its root/,
  );
});

test("keeps schema-one artifacts readable only as previous rollback slots", async () => {
  const artifactRoot = await mkdtemp(path.join(tmpdir(), "frontend-artifact-v1-"));
  await createRuntimeSlot(artifactRoot, "previous");
  await writeFile(
    path.join(artifactRoot, "deployment-manifest.json"),
    JSON.stringify({
      schema_version: 1,
      runtime_layout: "next-standalone",
      build_sha: buildSha,
      build_timestamp: "2026-07-26T00:00:00Z",
      bundler: "webpack",
      node_major: 22,
      platform: process.platform,
      arch: process.arch,
      next_version: "16.2.5",
      package_lock_sha256: "a".repeat(64),
      build_id: "previous",
      entrypoint: "server.js",
      dist_dir: ".next",
    }),
  );

  await validateArtifactDirectory(artifactRoot);
  await assert.rejects(
    validateArtifactDirectory(artifactRoot, { expectedBuildSha: buildSha }),
    /schema 2 is required/,
  );
});
