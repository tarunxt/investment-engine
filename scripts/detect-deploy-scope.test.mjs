import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  classifyDeploymentScope,
  combineDeploymentScopes,
} from "./detect-deploy-scope.mjs";

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

test("manual narrow scopes recover any unapplied current-main deployment", () => {
  assert.match(deployWorkflow, /Current main push deployment conclusion/);
  assert.match(
    deployWorkflow,
    /Broadening manual scope to full-stack because the current main SHA has no successful push deployment/,
  );
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
