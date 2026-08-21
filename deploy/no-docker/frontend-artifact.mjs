#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import {
  access,
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ARTIFACT_SCHEMA_VERSION = 2;
export const ACTIVE_BUILD_POINTER = ".next-active-dir";
export const BUILD_SLOT_NAMES = [".next", ".next-candidate"];
const REQUIRED_RUNTIME_ROUTES = [
  "/(auth)/login/page",
  "/api/auth/[...nextauth]/route",
  "/api/runtime-fingerprint/route",
  "/backend-api/[...path]/route",
  "/console/dashboard/page",
  "/console/bullpen-ai/page",
];
export const PUBLIC_BUILD_ENV_DEFAULTS = Object.freeze({
  NEXT_PUBLIC_API_URL: "https://api.cred-x.in",
  NEXT_PUBLIC_FRONTEND_URL: "https://cred-x.in",
  NEXT_PUBLIC_BRAND_PREFIX: "Cred-X",
  NEXT_PUBLIC_BRAND_ACRONYM: "TIE",
  NEXT_PUBLIC_BRAND_EXPANSION: "Tarun's Investment Engine",
  NEXT_PUBLIC_DISABLE_AUTH: "false",
  NEXT_PUBLIC_DISABLE_API_PROXY: "false",
  NEXT_PUBLIC_API_DEBUG: "false",
});

const FORBIDDEN_ROOT_ENTRIES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "Dockerfile",
  "Dockerfile.dev",
  "README.md",
  "components.json",
  "eslint.config.mjs",
  "package-lock.json",
  "postcss.config.mjs",
  "tests",
  "tsconfig.json",
  "tsconfig.tsbuildinfo",
]);

export function resolvePublicBuildEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(PUBLIC_BUILD_ENV_DEFAULTS).map(([name, fallback]) => {
      const rawValue = environment[name];
      const value = typeof rawValue === "string" ? rawValue.trim() : "";
      return [name, value || fallback];
    }),
  );
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertBuildSlotName(name) {
  if (!BUILD_SLOT_NAMES.includes(name)) {
    throw new Error(`Invalid frontend build slot: ${name || "<empty>"}`);
  }
}

export async function selectBuildSlots(frontendRoot) {
  const pointerPath = path.join(frontendRoot, ACTIVE_BUILD_POINTER);
  const active = (await pathExists(pointerPath))
    ? (await readFile(pointerPath, "utf8")).replaceAll("\r", "").trim()
    : ".next";

  assertBuildSlotName(active);
  return {
    active,
    inactive: active === ".next" ? ".next-candidate" : ".next",
  };
}

export async function isValidBuildSlot(slotPath) {
  const standaloneFilesPresent =
    (await pathExists(path.join(slotPath, "server.js"))) &&
    (await pathExists(path.join(slotPath, ".next", "BUILD_ID"))) &&
    (await pathExists(path.join(slotPath, ".next", "static")));
  if (standaloneFilesPresent) {
    try {
      await validateStandaloneLaunchRuntime(slotPath);
      return true;
    } catch {
      return false;
    }
  }

  // A pointerless standalone overlay owns frontend/.next as its internal
  // distribution directory. Never interpret that internal directory as an
  // outer legacy slot, even if stale shared dependencies later reappear.
  const frontendRoot = path.dirname(slotPath);
  if (
    path.basename(slotPath) === ".next" &&
    (await pathExists(path.join(frontendRoot, "server.js"))) &&
    (await pathExists(path.join(frontendRoot, "deployment-manifest.json")))
  ) {
    try {
      await validateStandaloneLaunchRuntime(frontendRoot, {
        allowSourceOverlay: true,
      });
      return false;
    } catch {
      // Stale root overlay files must not prevent a complete legacy .next
      // build from remaining a valid rollback target.
    }
  }

  return (
    (await pathExists(path.join(slotPath, "BUILD_ID"))) &&
    (await pathExists(path.join(slotPath, "static"))) &&
    (await isExecutable(
      path.join(frontendRoot, "node_modules", ".bin", "next"),
    ))
  );
}

async function isExecutable(targetPath) {
  try {
    await access(targetPath, fsConstants.X_OK);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ["EACCES", "ENOENT", "ENOTDIR"].includes(error.code)
    ) {
      return false;
    }
    throw error;
  }
}

async function inspectStandaloneRuntimeRoot(runtimeRoot, allowSourceOverlay) {
  try {
    await validateStandaloneLaunchRuntime(runtimeRoot, {
      allowSourceOverlay,
    });
    return { valid: true, reason: null };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function resolveFrontendLaunchTarget(frontendRoot) {
  const pointerPath = path.join(frontendRoot, ACTIVE_BUILD_POINTER);
  const pointerPresent = await pathExists(pointerPath);
  const slots = await selectBuildSlots(frontendRoot);
  const activeRuntimeRoot = path.join(frontendRoot, slots.active);
  const selectedRuntime = await inspectStandaloneRuntimeRoot(
    activeRuntimeRoot,
    false,
  );

  if (selectedRuntime.valid) {
    return {
      kind: "standalone-slot",
      runtimeRoot: activeRuntimeRoot,
      slot: slots.active,
    };
  }

  // Compatibility recovery for the first artifact rollout: a failed slot
  // migration may leave the complete standalone runtime at frontendRoot with
  // no pointer. Never use this fallback when a pointer exists, because that
  // would mask a corrupt or incomplete selected release.
  let rootRecovery = null;
  if (!pointerPresent) {
    rootRecovery = await inspectStandaloneRuntimeRoot(frontendRoot, true);
    if (rootRecovery.valid) {
      return {
        kind: "standalone-root-recovery",
        runtimeRoot: frontendRoot,
        slot: null,
      };
    }
  }

  if (
    (await pathExists(path.join(activeRuntimeRoot, "BUILD_ID"))) &&
    (await pathExists(path.join(activeRuntimeRoot, "static"))) &&
    (await isExecutable(
      path.join(frontendRoot, "node_modules", ".bin", "next"),
    ))
  ) {
    return {
      kind: "legacy-slot",
      runtimeRoot: activeRuntimeRoot,
      slot: slots.active,
    };
  }

  throw new Error(
    `No restartable frontend runtime is available for ${
      pointerPresent
        ? `selected slot ${slots.active}`
        : "the default slot or root recovery"
    }. Selected standalone validation: ${selectedRuntime.reason ?? "not attempted"}${
      rootRecovery
        ? `. Root recovery validation: ${rootRecovery.reason ?? "unknown failure"}`
        : ""
    }`,
  );
}

export async function writeActiveBuildPointer(frontendRoot, slotName) {
  assertBuildSlotName(slotName);
  const slotPath = path.join(frontendRoot, slotName);
  if (!(await isValidBuildSlot(slotPath))) {
    throw new Error(`Frontend build slot is incomplete: ${slotPath}`);
  }

  const pointerPath = path.join(frontendRoot, ACTIVE_BUILD_POINTER);
  const pendingPointerPath =
    `${pointerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(pendingPointerPath, `${slotName}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await rename(pendingPointerPath, pointerPath);
  } finally {
    await rm(pendingPointerPath, { force: true });
  }
}

export async function readArtifactManifest(artifactRoot) {
  const manifestPath = path.join(artifactRoot, "deployment-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid frontend deployment manifest at ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return manifest;
}

async function assertArtifactSymlinksStayInsideRoot(artifactRoot) {
  const root = await realpath(artifactRoot);
  const queue = [root];

  while (queue.length > 0) {
    const directory = queue.pop();
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const metadata = await lstat(entryPath);
      if (metadata.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (!metadata.isSymbolicLink()) {
        continue;
      }

      const resolved = await realpath(entryPath);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Artifact symlink escapes its root: ${entryPath}`);
      }
    }
  }
}

export async function validateArtifactDirectory(
  artifactRoot,
  {
    allowRuntimeCache = false,
    allowSourceOverlay = false,
    allowedBundler,
    expectedBuildSha,
    expectedPackageLockSha256,
    expectedPublicEnvironment,
  } = {},
) {
  const requiredPaths = [
    "server.js",
    "package.json",
    "node_modules/next/package.json",
    ".next/BUILD_ID",
    ".next/static",
    ".next/server",
    ".next/server/app-paths-manifest.json",
    ".next/server/functions-config-manifest.json",
    ".next/server/middleware-manifest.json",
    ".next/server/pages/500.html",
    ".next/required-server-files.json",
    "deployment-manifest.json",
  ];
  for (const relativePath of requiredPaths) {
    if (!(await pathExists(path.join(artifactRoot, relativePath)))) {
      throw new Error(`Frontend artifact is missing ${relativePath}`);
    }
  }

  if (
    !allowRuntimeCache &&
    (await pathExists(path.join(artifactRoot, ".next", "cache")))
  ) {
    throw new Error(
      "Frontend artifact must not contain the reusable build cache",
    );
  }

  const forbiddenEntries = [];
  if (!allowSourceOverlay) {
    for (const rootEntry of FORBIDDEN_ROOT_ENTRIES) {
      if (await pathExists(path.join(artifactRoot, rootEntry))) {
        forbiddenEntries.push(rootEntry);
      }
    }
  }
  const scanQueue = [path.resolve(artifactRoot)];
  while (scanQueue.length > 0) {
    const directory = scanQueue.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.relative(artifactRoot, entryPath);
      if (
        entry.name === ".git" ||
        entry.name.startsWith(".env") ||
        /\.(?:pem|key)$/i.test(entry.name)
      ) {
        forbiddenEntries.push(relativePath);
      }
      if (entry.isDirectory()) {
        scanQueue.push(entryPath);
      }
    }
  }
  if (forbiddenEntries.length > 0) {
    throw new Error(
      `Frontend artifact contains forbidden files: ${forbiddenEntries.join(", ")}`,
    );
  }

  const staticFiles = await readdir(
    path.join(artifactRoot, ".next", "static"),
    {
      recursive: true,
    },
  );
  if (!staticFiles.some((name) => name.endsWith(".js"))) {
    throw new Error(
      "Frontend artifact does not contain a static JavaScript asset",
    );
  }
  if (!staticFiles.some((name) => name.endsWith(".css"))) {
    throw new Error("Frontend artifact does not contain a static CSS asset");
  }

  const manifest = await readArtifactManifest(artifactRoot);
  if (![1, ARTIFACT_SCHEMA_VERSION].includes(manifest.schema_version)) {
    throw new Error(
      `Unsupported frontend artifact schema: ${manifest.schema_version}`,
    );
  }
  if (expectedBuildSha && manifest.schema_version !== ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `Frontend artifact schema ${ARTIFACT_SCHEMA_VERSION} is required for a new deployment`,
    );
  }
  if (manifest.runtime_layout !== "next-standalone") {
    throw new Error(
      `Unsupported frontend runtime layout: ${manifest.runtime_layout}`,
    );
  }
  if (!["webpack", "turbopack"].includes(manifest.bundler)) {
    throw new Error(`Unsupported frontend bundler: ${manifest.bundler}`);
  }
  if (allowedBundler && manifest.bundler !== allowedBundler) {
    throw new Error(
      `Frontend artifact bundler mismatch: expected ${allowedBundler}, received ${manifest.bundler}`,
    );
  }
  if (
    typeof manifest.build_sha !== "string" ||
    !/^[0-9a-f]{40}$/i.test(manifest.build_sha)
  ) {
    throw new Error(
      "Frontend artifact build_sha must be a 40-character Git SHA",
    );
  }
  if (expectedBuildSha && manifest.build_sha !== expectedBuildSha) {
    throw new Error(
      `Frontend artifact build SHA mismatch: expected ${expectedBuildSha}, received ${manifest.build_sha}`,
    );
  }
  if (
    typeof manifest.package_lock_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(manifest.package_lock_sha256)
  ) {
    throw new Error("Frontend artifact package-lock checksum is invalid");
  }
  if (
    expectedPackageLockSha256 &&
    manifest.package_lock_sha256 !== expectedPackageLockSha256
  ) {
    throw new Error(
      "Frontend artifact package-lock checksum does not match the deployed source",
    );
  }
  if (
    typeof manifest.node_major !== "number" ||
    !Number.isInteger(manifest.node_major) ||
    manifest.node_major < 20
  ) {
    throw new Error("Frontend artifact Node.js major version is invalid");
  }
  if (!["linux", "darwin"].includes(manifest.platform)) {
    throw new Error(
      `Frontend artifact platform is invalid: ${manifest.platform}`,
    );
  }
  if (!["x64", "arm64"].includes(manifest.arch)) {
    throw new Error(
      `Frontend artifact architecture is invalid: ${manifest.arch}`,
    );
  }
  if (manifest.entrypoint !== "server.js" || manifest.dist_dir !== ".next") {
    throw new Error("Frontend artifact runtime entrypoint metadata is invalid");
  }
  if (manifest.schema_version === ARTIFACT_SCHEMA_VERSION) {
    const resolvedPublicEnvironment = resolvePublicBuildEnvironment(
      manifest.public_environment ?? {},
    );
    if (
      JSON.stringify(resolvedPublicEnvironment) !==
      JSON.stringify(manifest.public_environment)
    ) {
      throw new Error(
        "Frontend artifact public build environment is incomplete",
      );
    }
    if (
      expectedPublicEnvironment &&
      JSON.stringify(resolvedPublicEnvironment) !==
        JSON.stringify(resolvePublicBuildEnvironment(expectedPublicEnvironment))
    ) {
      throw new Error(
        "Frontend artifact public build environment does not match production",
      );
    }
  }

  const nextPackage = JSON.parse(
    await readFile(
      path.join(artifactRoot, "node_modules", "next", "package.json"),
      "utf8",
    ),
  );
  if (!manifest.next_version || manifest.next_version !== nextPackage.version) {
    throw new Error(
      "Frontend artifact Next.js version does not match its manifest",
    );
  }

  const buildId = (
    await readFile(path.join(artifactRoot, ".next", "BUILD_ID"), "utf8")
  ).trim();
  if (!buildId || manifest.build_id !== buildId) {
    throw new Error("Frontend artifact BUILD_ID does not match its manifest");
  }

  const appPathsManifest = JSON.parse(
    await readFile(
      path.join(artifactRoot, ".next", "server", "app-paths-manifest.json"),
      "utf8",
    ),
  );
  for (const requiredRoute of REQUIRED_RUNTIME_ROUTES) {
    if (!appPathsManifest[requiredRoute]) {
      throw new Error(
        `Frontend artifact is missing key route: ${requiredRoute}`,
      );
    }
  }

  await assertArtifactSymlinksStayInsideRoot(artifactRoot);
  return manifest;
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function assertRuntimePathInsideRoot(runtimeRoot, candidatePath, description) {
  const root = path.resolve(runtimeRoot);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Frontend traced runtime ${description} escapes its root: ${candidatePath}`,
    );
  }
  return candidate;
}

async function assertRuntimeFile(filePath, description) {
  let metadata;
  try {
    metadata = await stat(filePath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ["ENOENT", "ENOTDIR"].includes(error.code)
    ) {
      throw new Error(`Frontend traced runtime is missing ${description}`);
    }
    throw error;
  }
  if (!metadata.isFile()) {
    throw new Error(`Frontend traced runtime ${description} is not a file`);
  }
}

async function readRuntimeJson(filePath, description) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid frontend traced runtime ${description}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function assertTracedRuntimeComplete(runtimeRoot) {
  const requiredServerFilesPath = path.join(
    runtimeRoot,
    ".next",
    "required-server-files.json",
  );
  const requiredServerFiles = await readRuntimeJson(
    requiredServerFilesPath,
    "required-server-files.json",
  );
  if (
    !Array.isArray(requiredServerFiles.files) ||
    requiredServerFiles.files.length === 0
  ) {
    throw new Error(
      "Frontend traced runtime required-server-files.json has no files",
    );
  }
  for (const relativePath of requiredServerFiles.files) {
    if (
      typeof relativePath !== "string" ||
      relativePath.length === 0 ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(
        "Frontend traced runtime required-server-files.json contains an invalid path",
      );
    }
    const requiredPath = assertRuntimePathInsideRoot(
      runtimeRoot,
      path.resolve(runtimeRoot, relativePath),
      `required server file ${relativePath}`,
    );
    await assertRuntimeFile(
      requiredPath,
      `required server file ${relativePath}`,
    );
  }

  await assertRuntimeFile(
    path.join(runtimeRoot, "node_modules", "next", "dist", "server", "next.js"),
    "Next.js server entrypoint",
  );

  const appPathsManifest = await readRuntimeJson(
    path.join(runtimeRoot, ".next", "server", "app-paths-manifest.json"),
    "app-paths-manifest.json",
  );
  for (const route of REQUIRED_RUNTIME_ROUTES) {
    const routeOutput = appPathsManifest[route];
    if (typeof routeOutput !== "string" || routeOutput.length === 0) {
      throw new Error(`Frontend traced runtime is missing key route: ${route}`);
    }
    const routeOutputPath = assertRuntimePathInsideRoot(
      runtimeRoot,
      path.resolve(runtimeRoot, ".next", "server", routeOutput),
      `route output for ${route}`,
    );
    await assertRuntimeFile(routeOutputPath, `route output for ${route}`);

    const tracePath = `${routeOutputPath}.nft.json`;
    await assertRuntimeFile(tracePath, `trace manifest for ${route}`);
    const trace = await readRuntimeJson(
      tracePath,
      `trace manifest for ${route}`,
    );
    if (!Array.isArray(trace.files) || trace.files.length === 0) {
      throw new Error(
        `Frontend traced runtime trace for ${route} has no files`,
      );
    }
    for (const relativePath of trace.files) {
      if (
        typeof relativePath !== "string" ||
        relativePath.length === 0 ||
        path.isAbsolute(relativePath)
      ) {
        throw new Error(
          `Frontend traced runtime trace for ${route} contains an invalid path`,
        );
      }
      const tracedPath = assertRuntimePathInsideRoot(
        runtimeRoot,
        path.resolve(path.dirname(tracePath), relativePath),
        `trace dependency for ${route}`,
      );
      await assertRuntimeFile(
        tracedPath,
        `trace dependency ${relativePath} for ${route}`,
      );
    }
  }
}

function assertHostArtifactCompatibility(manifest) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (manifest.platform !== process.platform) {
    throw new Error(
      `Frontend artifact platform mismatch: built for ${manifest.platform}, host is ${process.platform}`,
    );
  }
  if (manifest.arch !== process.arch) {
    throw new Error(
      `Frontend artifact architecture mismatch: built for ${manifest.arch}, host is ${process.arch}`,
    );
  }
  if (manifest.node_major !== nodeMajor) {
    throw new Error(
      `Frontend artifact Node.js mismatch: built with ${manifest.node_major}, host uses ${nodeMajor}`,
    );
  }
  const hostLibc =
    process.report?.getReport()?.header?.glibcVersionRuntime ?? "unknown";
  if (
    process.platform === "linux" &&
    /^\d+(?:\.\d+)+$/.test(manifest.libc ?? "") &&
    /^\d+(?:\.\d+)+$/.test(hostLibc) &&
    compareVersions(manifest.libc, hostLibc) > 0
  ) {
    throw new Error(
      `Frontend artifact glibc ${manifest.libc} is newer than host glibc ${hostLibc}`,
    );
  }
}

export async function validateStandaloneLaunchRuntime(
  runtimeRoot,
  { allowSourceOverlay = false } = {},
) {
  const manifest = await validateArtifactDirectory(runtimeRoot, {
    // Packaging excludes the reusable build cache, but a live Next.js
    // runtime may create its own image/data cache after promotion. That cache
    // must not make a previously validated slot unstartable.
    allowRuntimeCache: true,
    allowSourceOverlay,
    allowedBundler: "webpack",
  });
  assertHostArtifactCompatibility(manifest);
  await assertTracedRuntimeComplete(runtimeRoot);
  return manifest;
}

async function main() {
  const [
    command,
    target,
    value,
    sourcePackageLock,
    allowedBundler,
    comparePublicEnvironment,
    allowRuntimeCache,
  ] = process.argv.slice(2);
  switch (command) {
    case "select": {
      const slots = await selectBuildSlots(path.resolve(target));
      process.stdout.write(`${slots.active}\t${slots.inactive}\n`);
      return;
    }
    case "validate": {
      const manifest = await validateArtifactDirectory(path.resolve(target), {
        expectedBuildSha: value || undefined,
      });
      process.stdout.write(`${JSON.stringify(manifest)}\n`);
      return;
    }
    case "validate-host": {
      const expectedPackageLockSha256 =
        sourcePackageLock && sourcePackageLock !== "-"
          ? await sha256File(path.resolve(sourcePackageLock))
          : undefined;
      const manifest = await validateArtifactDirectory(path.resolve(target), {
        allowRuntimeCache: allowRuntimeCache === "true",
        allowedBundler:
          allowedBundler && allowedBundler !== "-" ? allowedBundler : undefined,
        expectedBuildSha: value || undefined,
        expectedPackageLockSha256,
        expectedPublicEnvironment:
          comparePublicEnvironment === "true" ? process.env : undefined,
      });
      assertHostArtifactCompatibility(manifest);
      process.stdout.write(`${JSON.stringify(manifest)}\n`);
      return;
    }
    case "point": {
      await writeActiveBuildPointer(path.resolve(target), value);
      return;
    }
    case "resolve-launch": {
      const launchTarget = await resolveFrontendLaunchTarget(
        path.resolve(target),
      );
      process.stdout.write(
        `${launchTarget.kind}\t${launchTarget.runtimeRoot}\t${launchTarget.slot ?? ""}\n`,
      );
      return;
    }
    default:
      throw new Error(
        "Usage: frontend-artifact.mjs select <frontend-root> | validate <artifact-root> [expected-sha] | validate-host <artifact-root> [expected-sha] [source-package-lock|-] [allowed-bundler|-] [compare-public-env] [allow-runtime-cache] | point <frontend-root> <slot> | resolve-launch <frontend-root>",
      );
  }
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
