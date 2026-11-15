import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  classifyDeploymentScope,
  combineDeploymentScopes,
} from "./detect-deploy-scope.mjs";

import { resolveReleaseScope } from "./resolve-deploy-scope.mjs";

const execFileAsync = promisify(execFile);
const scopeScript = fileURLToPath(
  new URL("./detect-deploy-scope.mjs", import.meta.url),
);
const deployWorkflow = await readFile(
  new URL("../.github/workflows/deploy.yml", import.meta.url),
  "utf8",
);
const recoveryWorkflow = await readFile(
  new URL("../.github/workflows/production-disk-recovery.yml", import.meta.url),
  "utf8",
);

test("classifies changes confined to frontend as frontend-only", () => {
  assert.equal(
    classifyDeploymentScope([
      "frontend/app/page.tsx",
      "frontend/package-lock.json",
      "frontend/tests/example.test.mjs",
    ]),
    "frontend-only",
  );
});

test("classifies changes confined to backend as backend-only", () => {
  assert.equal(
    classifyDeploymentScope([
      "backend/app/main.py",
      "backend/tests/test_health_ready.py",
    ]),
    "backend-only",
  );
});

test("classifies combined frontend and backend changes as full-stack", () => {
  assert.equal(
    classifyDeploymentScope([
      "frontend/app/page.tsx",
      "backend/app/main.py",
    ]),
    "full-stack",
  );
});

test("classifies deployment, workflow, script, and env template changes as full-stack", () => {
  for (const path of [
    ".github/workflows/deploy.yml",
    "deploy/no-docker/redeploy.sh",
    "scripts/release-prod.sh",
    ".env.prod.example",
    "deploy/no-docker/frontend.env.example",
  ]) {
    assert.equal(classifyDeploymentScope([path]), "full-stack", path);
  }
});

test("does not deploy documentation-only changes", () => {
  assert.equal(
    classifyDeploymentScope(["README.md", "docs/production-deploy.md"]),
    "none",
  );
});

test("unknown and newly introduced shared paths fail closed to full-stack", () => {
  for (const path of [
    "packages/shared-auth/package.json",
    "next.config.shared.mjs",
    "config/runtime.json",
    "new-root-tool.ts",
  ]) {
    assert.equal(classifyDeploymentScope([path]), "full-stack", path);
  }
});

test("normalizes duplicate and platform-style paths", () => {
  assert.equal(
    classifyDeploymentScope([
      "./frontend/app/page.tsx",
      "frontend\\app\\page.tsx",
    ]),
    "frontend-only",
  );
});

test("combines an explicit release scope without masking detected changes", () => {
  assert.equal(
    combineDeploymentScopes("frontend-only", "backend-only"),
    "full-stack",
  );
  assert.equal(
    combineDeploymentScopes("backend-only", "backend-only"),
    "backend-only",
  );
  assert.equal(combineDeploymentScopes("none", "frontend-only"), "frontend-only");
  assert.equal(combineDeploymentScopes("full-stack", "frontend-only"), "full-stack");
});

test("rejects unknown deployment scopes", () => {
  assert.throws(
    () => combineDeploymentScopes("frontend-only", "surprise"),
    /Cannot combine deployment scopes/,
  );
});

test("scope CLI executes through a symlinked workspace path", async () => {
  const testRoot = await mkdtemp(
    path.join(tmpdir(), "deploy-scope-cli-symlink-"),
  );
  const scopeLink = path.join(testRoot, "detect-deploy-scope.mjs");
  await symlink(scopeScript, scopeLink);

  const { stdout } = await execFileAsync(process.execPath, [
    scopeLink,
    "--combine",
    "frontend-only",
    "backend-only",
  ]);
  assert.equal(stdout.trim(), "full-stack");
});

test("production deployment remains cancellable while optional build jobs may skip", () => {
  assert.match(
    deployWorkflow,
    /if: >-\n\s+!cancelled\(\) &&\n\s+needs\.detect-changes\.result == 'success'/,
  );
  assert.doesNotMatch(
    deployWorkflow,
    /if: >-\n\s+always\(\) &&\n\s+needs\.detect-changes\.result == 'success'/,
  );
});

test("scope resolution is delegated to the executable fail-closed resolver", () => {
  assert.match(deployWorkflow, /node scripts\/resolve-deploy-scope.mjs/);
  assert.match(deployWorkflow, /frontend_base_sha: \$\{\{ steps.scope.outputs.frontend_base_sha \}\}/);
});

test("deploy and recovery use independent queues plus one production host lock", () => {
  assert.match(deployWorkflow, /group: production-deploy/);
  assert.match(recoveryWorkflow, /group: production-recovery/);
  for (const workflow of [deployWorkflow, recoveryWorkflow]) {
    assert.match(
      workflow,
      /DEPLOY_LOCK_FILE=['"]?\/run\/investor-production-deploy\.lock/,
    );
    assert.match(workflow, /\bflock\b/);
  }
});

test("operator-managed SSH windows require an explicit scope and immutable SHA", () => {
  const sha = "1".repeat(40);
  const io = { git: () => sha };
  const input = { event: "workflow_dispatch", ref: "refs/heads/main", sha, requestedScope: "full", runnerSshWindow: true };
  for (const expectedSha of [undefined, "", "2".repeat(40)]) {
    assert.throws(() => resolveReleaseScope({ ...input, expectedSha }, io), /exact reviewed SHA/);
  }
  assert.equal(resolveReleaseScope({ ...input, expectedSha: sha }, io).scope, "full-stack");
  assert.throws(() => resolveReleaseScope({ ...input, expectedSha: sha, requestedScope: "auto" }, io), /explicit frontend or full/);
  assert.equal(resolveReleaseScope({ ...input, runnerSshWindow: false }, io).scope, "full-stack");
});

test("both production runners publish their own source before attempting SSH", () => {
  const [build, deploy] = deployWorkflow.split("  deploy-production:");
  for (const [job, prefix, firstRemote] of [[build, "&", "uses: appleboy/ssh-action"], [deploy, "*", "uses: appleboy/scp-action"]]) {
    const positions = ["record-runner-address", "publish-runner-address", "wait-for-ssh"].map(name => job.indexOf(prefix + name));
    positions.push(job.indexOf(firstRemote));
    assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])));
  }
  assert.match(build, /retention-days: 1\n/);
  assert.match(build, /github\.run_attempt.*github\.job.*steps\.runner-address\.outputs\.ipv4/);
});
