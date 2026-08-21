import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  resolvePublicBuildEnvironment,
  resolveFrontendLaunchTarget,
  selectBuildSlots,
  validateArtifactDirectory,
  validateStandaloneLaunchRuntime,
  writeActiveBuildPointer,
} from "./frontend-artifact.mjs";

const execFileAsync = promisify(execFile);
const packageScript = fileURLToPath(
  new URL("./package-frontend-artifact.sh", import.meta.url),
);
const launcherScript = fileURLToPath(
  new URL("./scripts/run-frontend.sh", import.meta.url),
);
const artifactHelper = fileURLToPath(
  new URL("./frontend-artifact.mjs", import.meta.url),
);
const runtimeVerifier = fileURLToPath(
  new URL("../../scripts/verify-frontend-artifact-runtime.mjs", import.meta.url),
);
const buildSha = "0123456789abcdef0123456789abcdef01234567";
const packageLockContents = '{"lockfileVersion":3}\n';
const packageLockSha256 = createHash("sha256")
  .update(packageLockContents)
  .digest("hex");
const requiredRoutes = {
  "/(auth)/login/page": "app/login.js",
  "/api/auth/[...nextauth]/route": "app/auth.js",
  "/api/runtime-fingerprint/route": "app/fingerprint.js",
  "/backend-api/[...path]/route": "app/proxy.js",
  "/console/dashboard/page": "app/dashboard.js",
  "/console/bullpen-ai/page": "app/bullpen.js",
};

async function createRuntimeSlot(slotPath, marker) {
  await mkdir(path.join(slotPath, ".next", "static"), { recursive: true });
  await mkdir(path.join(slotPath, ".next", "server", "pages"), {
    recursive: true,
  });
  await mkdir(path.join(slotPath, "node_modules", "next"), { recursive: true });
  await mkdir(path.join(slotPath, "node_modules", "next", "dist", "server"), {
    recursive: true,
  });
  await writeFile(path.join(slotPath, "server.js"), "// standalone\n");
  await writeFile(path.join(slotPath, "package.json"), '{"type":"commonjs"}\n');
  await writeFile(
    path.join(slotPath, "deployment-manifest.json"),
    `${JSON.stringify({
      schema_version: 2,
      runtime_layout: "next-standalone",
      build_sha: buildSha,
      build_timestamp: "2026-07-26T00:00:00Z",
      bundler: "webpack",
      node_major: Number(process.versions.node.split(".")[0]),
      platform: process.platform,
      arch: process.arch,
      libc:
        process.report?.getReport()?.header?.glibcVersionRuntime ??
        (process.platform === "linux" ? "unknown" : "not-applicable"),
      next_version: "16.2.5",
      package_lock_sha256: packageLockSha256,
      build_id: marker,
      entrypoint: "server.js",
      dist_dir: ".next",
      public_environment: resolvePublicBuildEnvironment(process.env),
    })}\n`,
  );
  await writeFile(
    path.join(slotPath, "node_modules", "next", "package.json"),
    '{"version":"16.2.5"}\n',
  );
  await writeFile(
    path.join(slotPath, "node_modules", "next", "dist", "server", "next.js"),
    "module.exports = {}\n",
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
    `${JSON.stringify({
      version: 1,
      config: {},
      files: [
        ".next/BUILD_ID",
        ".next/server/app-paths-manifest.json",
        ".next/server/functions-config-manifest.json",
        ".next/server/middleware-manifest.json",
        ".next/required-server-files.json",
      ],
    })}\n`,
  );
  await writeFile(
    path.join(slotPath, ".next", "server", "app-paths-manifest.json"),
    `${JSON.stringify(requiredRoutes)}\n`,
  );
  for (const routeOutput of Object.values(requiredRoutes)) {
    const outputPath = path.join(slotPath, ".next", "server", routeOutput);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "module.exports = {}\n");
    await writeFile(
      `${outputPath}.nft.json`,
      `${JSON.stringify({ version: 1, files: [path.basename(outputPath)] })}\n`,
    );
  }
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

async function writeSourcePackageLock(frontendRoot) {
  await writeFile(
    path.join(frontendRoot, "package-lock.json"),
    packageLockContents,
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

test("resolves standalone, root-recovery, and legacy launch targets", async () => {
  const standaloneRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-launch-slot-"),
  );
  await createRuntimeSlot(
    path.join(standaloneRoot, ".next-candidate"),
    "standalone-slot",
  );
  await writeSourcePackageLock(standaloneRoot);
  await writeFile(
    path.join(standaloneRoot, ".next-active-dir"),
    ".next-candidate\n",
  );
  assert.deepEqual(await resolveFrontendLaunchTarget(standaloneRoot), {
    kind: "standalone-slot",
    runtimeRoot: path.join(standaloneRoot, ".next-candidate"),
    slot: ".next-candidate",
  });

  const rootRecovery = await mkdtemp(
    path.join(tmpdir(), "frontend-launch-root-"),
  );
  await createRuntimeSlot(rootRecovery, "root-recovery");
  await writeSourcePackageLock(rootRecovery);
  assert.deepEqual(await resolveFrontendLaunchTarget(rootRecovery), {
    kind: "standalone-root-recovery",
    runtimeRoot: rootRecovery,
    slot: null,
  });

  const legacyRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-launch-legacy-"),
  );
  await mkdir(path.join(legacyRoot, ".next", "static"), { recursive: true });
  await mkdir(path.join(legacyRoot, "node_modules", ".bin"), {
    recursive: true,
  });
  await writeFile(path.join(legacyRoot, ".next", "BUILD_ID"), "legacy\n");
  const legacyExecutable = path.join(
    legacyRoot,
    "node_modules",
    ".bin",
    "next",
  );
  await writeFile(legacyExecutable, "#!/bin/sh\n");
  await chmod(legacyExecutable, 0o755);
  assert.deepEqual(await resolveFrontendLaunchTarget(legacyRoot), {
    kind: "legacy-slot",
    runtimeRoot: path.join(legacyRoot, ".next"),
    slot: ".next",
  });
});

test("never masks a broken selected slot with root recovery", async () => {
  const frontendRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-launch-broken-pointer-"),
  );
  await createRuntimeSlot(frontendRoot, "root-recovery");
  await writeSourcePackageLock(frontendRoot);
  await writeFile(
    path.join(frontendRoot, ".next-active-dir"),
    ".next-candidate\n",
  );
  await assert.rejects(
    resolveFrontendLaunchTarget(frontendRoot),
    /No restartable frontend runtime.*selected slot \.next-candidate/,
  );
});

test("keeps an old standalone slot restartable across source lock and public environment drift", async () => {
  const frontendRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-launch-old-slot-"),
  );
  await createRuntimeSlot(
    path.join(frontendRoot, ".next-candidate"),
    "previous-release",
  );
  await writeFile(
    path.join(frontendRoot, "package-lock.json"),
    '{"lockfileVersion":3,"packages":{"drifted":{}}}\n',
  );
  await writeFile(
    path.join(frontendRoot, ".next-active-dir"),
    ".next-candidate\n",
  );

  const previousBrandPrefix = process.env.NEXT_PUBLIC_BRAND_PREFIX;
  process.env.NEXT_PUBLIC_BRAND_PREFIX = "Changed after previous release";
  try {
    assert.deepEqual(await resolveFrontendLaunchTarget(frontendRoot), {
      kind: "standalone-slot",
      runtimeRoot: path.join(frontendRoot, ".next-candidate"),
      slot: ".next-candidate",
    });
  } finally {
    if (previousBrandPrefix === undefined) {
      delete process.env.NEXT_PUBLIC_BRAND_PREFIX;
    } else {
      process.env.NEXT_PUBLIC_BRAND_PREFIX = previousBrandPrefix;
    }
  }
});

test("keeps a standalone slot restartable after Next.js creates runtime cache entries", async () => {
  const frontendRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-launch-runtime-cache-"),
  );
  const slotRoot = path.join(frontendRoot, ".next");
  await createRuntimeSlot(slotRoot, "runtime-cache");
  await writeSourcePackageLock(frontendRoot);
  await mkdir(path.join(slotRoot, ".next", "cache", "images"), {
    recursive: true,
  });
  await writeFile(
    path.join(slotRoot, ".next", "cache", "images", "runtime-entry"),
    "runtime cache\n",
  );

  assert.deepEqual(await resolveFrontendLaunchTarget(frontendRoot), {
    kind: "standalone-slot",
    runtimeRoot: slotRoot,
    slot: ".next",
  });
});

test("does not misclassify a root artifact's internal dist directory as a slot", async () => {
  const frontendRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-launch-root-collision-"),
  );
  await createRuntimeSlot(frontendRoot, "root-recovery");
  await writeSourcePackageLock(frontendRoot);
  await mkdir(path.join(frontendRoot, "node_modules", ".bin"), {
    recursive: true,
  });
  const staleLegacyExecutable = path.join(
    frontendRoot,
    "node_modules",
    ".bin",
    "next",
  );
  await writeFile(staleLegacyExecutable, "#!/bin/sh\n");
  await chmod(staleLegacyExecutable, 0o755);
  assert.equal(
    (await resolveFrontendLaunchTarget(frontendRoot)).kind,
    "standalone-root-recovery",
  );
  await assert.rejects(
    writeActiveBuildPointer(frontendRoot, ".next"),
    /Frontend build slot is incomplete/,
  );
});

test("strictly validates a pointerless root runtime while permitting source overlays", async () => {
  const frontendRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-launch-root-overlay-"),
  );
  await createRuntimeSlot(frontendRoot, "root-overlay");
  await writeSourcePackageLock(frontendRoot);
  await writeFile(path.join(frontendRoot, "AGENTS.md"), "source overlay\n");
  await writeFile(path.join(frontendRoot, "README.md"), "source overlay\n");
  await mkdir(path.join(frontendRoot, ".next", "cache", "images"), {
    recursive: true,
  });
  await writeFile(
    path.join(frontendRoot, ".next", "cache", "images", "runtime-entry"),
    "runtime cache\n",
  );

  const manifest = await validateStandaloneLaunchRuntime(frontendRoot, {
    allowSourceOverlay: true,
  });
  assert.equal(manifest.build_id, "root-overlay");
  assert.equal(
    (await resolveFrontendLaunchTarget(frontendRoot)).kind,
    "standalone-root-recovery",
  );
});

test("launcher executes a validated pointerless root runtime without leaking NEXT_DIST_DIR", async () => {
  const appRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-launcher-root-recovery-"),
  );
  const frontendRoot = path.join(appRoot, "frontend");
  const helperTarget = path.join(
    appRoot,
    "deploy",
    "no-docker",
    "frontend-artifact.mjs",
  );
  const observationPath = path.join(appRoot, "launch-observation.json");

  await createRuntimeSlot(frontendRoot, "launcher-root-recovery");
  await writeSourcePackageLock(frontendRoot);
  await mkdir(path.dirname(helperTarget), { recursive: true });
  await copyFile(artifactHelper, helperTarget);
  await writeFile(
    path.join(frontendRoot, "server.js"),
    [
      'const fs = require("node:fs");',
      "fs.writeFileSync(",
      "  process.env.LAUNCH_OBSERVATION,",
      "  JSON.stringify({",
      "    cwd: process.cwd(),",
      "    hostname: process.env.HOSTNAME,",
      "    nextDistDir: process.env.NEXT_DIST_DIR ?? null,",
      "  }),",
      ");",
      "",
    ].join("\n"),
  );

  const { stderr } = await execFileAsync("bash", [launcherScript], {
    env: {
      ...process.env,
      APP_ROOT: appRoot,
      LAUNCH_OBSERVATION: observationPath,
      NEXT_DIST_DIR: ".next-candidate",
    },
  });
  const observation = JSON.parse(await readFile(observationPath, "utf8"));

  assert.match(stderr, /validated root standalone runtime/);
  assert.deepEqual(observation, {
    cwd: await realpath(frontendRoot),
    hostname: "127.0.0.1",
    nextDistDir: null,
  });
});

test("runtime verifier executes through a symlinked production path", async () => {
  const testRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-runtime-verifier-symlink-"),
  );
  const verifierLink = path.join(testRoot, "verify-runtime.mjs");
  await symlink(runtimeVerifier, verifierLink);

  await assert.rejects(
    execFileAsync(process.execPath, [verifierLink]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Usage: verify-frontend-artifact-runtime/);
      return true;
    },
  );
});

test("root recovery rejects nested secrets and incomplete traced runtime files", async () => {
  const secretRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-launch-root-secret-"),
  );
  await createRuntimeSlot(secretRoot, "root-secret");
  await writeSourcePackageLock(secretRoot);
  await mkdir(path.join(secretRoot, "config"));
  await writeFile(
    path.join(secretRoot, "config", ".env.production"),
    "SECRET=x\n",
  );
  await assert.rejects(
    resolveFrontendLaunchTarget(secretRoot),
    /contains forbidden files: config\/\.env\.production/,
  );

  const incompleteRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-launch-root-incomplete-"),
  );
  await createRuntimeSlot(incompleteRoot, "root-incomplete");
  await writeSourcePackageLock(incompleteRoot);
  await rm(
    path.join(
      incompleteRoot,
      ".next",
      "server",
      `${requiredRoutes["/api/runtime-fingerprint/route"]}.nft.json`,
    ),
  );
  await assert.rejects(
    resolveFrontendLaunchTarget(incompleteRoot),
    /missing trace manifest for \/api\/runtime-fingerprint\/route/,
  );
});

test("root recovery rejects host-incompatible manifests and escaping runtime symlinks", async () => {
  const incompatibleRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-launch-root-host-"),
  );
  await createRuntimeSlot(incompatibleRoot, "root-host");
  await writeSourcePackageLock(incompatibleRoot);
  const incompatibleManifestPath = path.join(
    incompatibleRoot,
    "deployment-manifest.json",
  );
  const incompatibleManifest = JSON.parse(
    await readFile(incompatibleManifestPath, "utf8"),
  );
  incompatibleManifest.platform =
    process.platform === "linux" ? "darwin" : "linux";
  await writeFile(
    incompatibleManifestPath,
    `${JSON.stringify(incompatibleManifest)}\n`,
  );
  await assert.rejects(
    resolveFrontendLaunchTarget(incompatibleRoot),
    /platform mismatch/,
  );

  const escapingRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-launch-root-symlink-"),
  );
  await createRuntimeSlot(escapingRoot, "root-symlink");
  await writeSourcePackageLock(escapingRoot);
  await symlink(
    tmpdir(),
    path.join(escapingRoot, ".next", "server", "escaping-runtime-link"),
  );
  await assert.rejects(
    resolveFrontendLaunchTarget(escapingRoot),
    /Artifact symlink escapes its root/,
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
    (
      await readFile(path.join(frontendRoot, ".next-active-dir"), "utf8")
    ).trim(),
    ".next-candidate",
  );

  const candidateVerificationPassed = false;
  if (!candidateVerificationPassed) {
    await writeActiveBuildPointer(frontendRoot, ".next");
  }

  assert.equal(
    (
      await readFile(path.join(frontendRoot, ".next-active-dir"), "utf8")
    ).trim(),
    ".next",
  );
  assert.equal(
    (
      await readFile(
        path.join(frontendRoot, ".next", ".next", "BUILD_ID"),
        "utf8",
      )
    ).trim(),
    "previous",
  );
});

test("atomic pointer replacement never follows an existing pointer symlink", async () => {
  const frontendRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-pointer-symlink-"),
  );
  const victimPath = path.join(frontendRoot, "must-not-change");
  const pointerPath = path.join(frontendRoot, ".next-active-dir");
  await createRuntimeSlot(
    path.join(frontendRoot, ".next-candidate"),
    "candidate",
  );
  await writeFile(victimPath, "unchanged\n");
  await symlink(victimPath, pointerPath);

  await writeActiveBuildPointer(frontendRoot, ".next-candidate");

  assert.equal(await readFile(victimPath, "utf8"), "unchanged\n");
  assert.equal((await readFile(pointerPath, "utf8")).trim(), ".next-candidate");
  assert.equal((await lstat(pointerPath)).isSymbolicLink(), false);
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
  await writeFile(
    path.join(projectRoot, "package-lock.json"),
    '{"lockfileVersion":3}\n',
  );
  await writeFile(path.join(buildRoot, "BUILD_ID"), "build-id\n");
  await writeFile(
    path.join(buildRoot, "static", "app.js"),
    "console.log('ok')\n",
  );
  await writeFile(path.join(buildRoot, "static", "app.css"), "body{}\n");
  await writeFile(
    path.join(buildRoot, "cache", "expensive-cache"),
    "not deployable\n",
  );
  await writeFile(path.join(standaloneRoot, "server.js"), "// standalone\n");
  await writeFile(
    path.join(standaloneRoot, "public", "stale-public-file"),
    "must be replaced\n",
  );
  await writeFile(
    path.join(standaloneRoot, "tests", "not-runtime.test.mjs"),
    "throw new Error('must not deploy')\n",
  );
  await writeFile(
    path.join(standaloneRoot, "package.json"),
    '{"type":"commonjs"}\n',
  );
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
    path.join(
      standaloneRoot,
      ".next",
      "server",
      "functions-config-manifest.json",
    ),
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
  const artifactRoot = await mkdtemp(
    path.join(tmpdir(), "frontend-artifact-v1-"),
  );
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
