#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ARTIFACT_SCHEMA_VERSION = 2;
export const ACTIVE_BUILD_POINTER = ".next-active-dir";
export const BUILD_SLOT_NAMES = [".next", ".next-candidate"];
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
    return true;
  }

  return (
    (await pathExists(path.join(slotPath, "BUILD_ID"))) &&
    (await pathExists(path.join(slotPath, "static")))
  );
}

export async function writeActiveBuildPointer(frontendRoot, slotName) {
  assertBuildSlotName(slotName);
  const slotPath = path.join(frontendRoot, slotName);
  if (!(await isValidBuildSlot(slotPath))) {
    throw new Error(`Frontend build slot is incomplete: ${slotPath}`);
  }

  const pointerPath = path.join(frontendRoot, ACTIVE_BUILD_POINTER);
  const pendingPointerPath = `${pointerPath}.next`;
  await writeFile(pendingPointerPath, `${slotName}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  await rename(pendingPointerPath, pointerPath);
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
    throw new Error("Frontend artifact must not contain the reusable build cache");
  }

  const forbiddenEntries = [];
  for (const rootEntry of FORBIDDEN_ROOT_ENTRIES) {
    if (await pathExists(path.join(artifactRoot, rootEntry))) {
      forbiddenEntries.push(rootEntry);
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

  const staticFiles = await readdir(path.join(artifactRoot, ".next", "static"), {
    recursive: true,
  });
  if (!staticFiles.some((name) => name.endsWith(".js"))) {
    throw new Error("Frontend artifact does not contain a static JavaScript asset");
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
    throw new Error(`Unsupported frontend runtime layout: ${manifest.runtime_layout}`);
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
    throw new Error("Frontend artifact build_sha must be a 40-character Git SHA");
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
    throw new Error(`Frontend artifact platform is invalid: ${manifest.platform}`);
  }
  if (!["x64", "arm64"].includes(manifest.arch)) {
    throw new Error(`Frontend artifact architecture is invalid: ${manifest.arch}`);
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
      throw new Error("Frontend artifact public build environment is incomplete");
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
    throw new Error("Frontend artifact Next.js version does not match its manifest");
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
  for (const requiredRoute of [
    "/(auth)/login/page",
    "/api/auth/[...nextauth]/route",
    "/api/runtime-fingerprint/route",
    "/backend-api/[...path]/route",
    "/console/dashboard/page",
    "/console/bullpen-ai/page",
  ]) {
    if (!appPathsManifest[requiredRoute]) {
      throw new Error(`Frontend artifact is missing key route: ${requiredRoute}`);
    }
  }

  await assertArtifactSymlinksStayInsideRoot(artifactRoot);
  return manifest;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
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
      process.stdout.write(`${JSON.stringify(manifest)}\n`);
      return;
    }
    case "point": {
      await writeActiveBuildPointer(path.resolve(target), value);
      return;
    }
    default:
      throw new Error(
        "Usage: frontend-artifact.mjs select <frontend-root> | validate <artifact-root> [expected-sha] | validate-host <artifact-root> [expected-sha] [source-package-lock|-] [allowed-bundler|-] [compare-public-env] [allow-runtime-cache] | point <frontend-root> <slot>",
      );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
