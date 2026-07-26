import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const redeploy = await readFile(
  new URL("./redeploy.sh", import.meta.url),
  "utf8",
);
const launcher = await readFile(
  new URL("./scripts/run-frontend.sh", import.meta.url),
  "utf8",
);

function section(start, end) {
  const startIndex = redeploy.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = redeploy.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return redeploy.slice(startIndex, endIndex);
}

test("frontend-only deployment cannot install or restart backend services", () => {
  const frontendTransaction = section(
    'if [[ "$DEPLOY_FRONTEND" == "true" ]]; then\n  start_phase "frontend-service-restart"',
    'echo "==> Service status"',
  );

  assert.match(
    frontendTransaction,
    /systemctl restart "\$FRONTEND_SERVICE_NAME"/,
  );
  assert.doesNotMatch(frontendTransaction, /\bpip install\b/);
  assert.doesNotMatch(frontendTransaction, /\balembic\b/);
  assert.doesNotMatch(frontendTransaction, /\$BACKEND_SERVICE_NAME/);
  assert.doesNotMatch(frontendTransaction, /\$WORKER_SERVICE_NAME/);
  assert.doesNotMatch(frontendTransaction, /\$BEAT_SERVICE_NAME/);

  const backendTransaction = section(
    'if [[ "$DEPLOY_BACKEND" == "true" ]]; then\n  start_phase "backend-dependencies-migrations"',
    'if [[ "$DEPLOY_FRONTEND" == "true" ]]; then\n  start_phase "frontend-service-restart"',
  );
  assert.match(backendTransaction, /\bpip install -r requirements\.txt/);
  assert.match(backendTransaction, /\balembic upgrade head/);
  assert.match(backendTransaction, /\$BACKEND_SERVICE_NAME/);
  assert.match(
    backendTransaction,
    /\[\[ "\$DEPLOY_FRONTEND" != "true" \]\][\s\S]*same-origin backend proxy/,
  );
});

test("every post-promotion failure remains inside the automatic rollback boundary", () => {
  const exitHandler = section(
    "handle_deploy_exit() {",
    "trap handle_deploy_exit EXIT",
  );
  assert.match(
    exitHandler,
    /\[\[ "\$FRONTEND_PROMOTED" == "true" \]\][\s\S]*restore_previous_frontend_build/,
  );

  const frontendTransaction = section(
    'if [[ "$DEPLOY_FRONTEND" == "true" ]]; then\n  start_phase "frontend-service-restart"',
    'echo "==> Service status"',
  );
  for (const gate of [
    "verify_service_active",
    "verify_frontend_fingerprint",
    "frontend login",
    "Auth.js CSRF",
    "Auth.js providers",
    "frontend console dashboard",
    "frontend Bullpen AI console",
    "smoke_check_frontend_static_asset",
    "same-origin backend proxy",
  ]) {
    assert.match(frontendTransaction, new RegExp(gate.replaceAll(".", "\\.")), gate);
  }
  assert.ok(
    frontendTransaction.indexOf("verify_frontend_fingerprint") <
      frontendTransaction.indexOf("same-origin backend proxy"),
  );
  assert.ok(
    redeploy.indexOf('systemctl status "$FRONTEND_SERVICE_NAME"') <
      redeploy.lastIndexOf("discard_previous_frontend_build"),
    "rollback guard must remain armed through final service status",
  );
});

test("candidate preparation never removes or rebuilds the active slot", () => {
  const artifactPreparation = section(
    "prepare_frontend_candidate_artifact() {",
    "prepare_frontend_candidate_build_on_host() {",
  );
  assert.match(
    artifactPreparation,
    /rm -rf -- '\$FRONTEND_CANDIDATE_BUILD_DIR'/,
  );
  assert.match(
    artifactPreparation,
    /tar --no-same-owner -xzf '\$FRONTEND_ARTIFACT' -C '\$FRONTEND_CANDIDATE_BUILD_DIR'/,
  );
  assert.match(
    artifactPreparation,
    /validate-host[\s\S]*'\$FRONTEND_CANDIDATE_BUILD_DIR'/,
  );
  assert.doesNotMatch(artifactPreparation, /rm -rf[^\n]*FRONTEND_LIVE_BUILD_DIR/);
  assert.doesNotMatch(artifactPreparation, /FRONTEND_STAGING_DIR|\.frontend-stage|mv --/);
  assert.doesNotMatch(redeploy, /FRONTEND_RECOVERY_BUILD_IN_PLACE/);
  assert.match(artifactPreparation, /verify-frontend-artifact-runtime\.mjs/);
  assert.match(artifactPreparation, /\n\s+webpack\s*\\/);
  assert.match(artifactPreparation, /package-lock\.json/);
});

test("slot selection is fail-closed and promotion revalidates the exact candidate", () => {
  const selection = section(
    "select_frontend_build_slots() {",
    "frontend_slot_is_valid() {",
  );
  assert.match(selection, /\$'\.next\\t\.next-candidate'/);
  assert.match(selection, /\$'\.next-candidate\\t\.next'/);
  assert.match(selection, /Frontend slots escaped their allowed roots/);
  assert.doesNotMatch(selection, /IFS=.*read/);

  const promotion = section(
    "promote_frontend_candidate_build() {",
    "verify_restored_frontend_build() {",
  );
  assert.match(
    promotion,
    /validate-host[\s\S]*'\$FRONTEND_CANDIDATE_BUILD_DIR'/,
  );
  assert.match(promotion, /Frontend promotion pointer mismatch/);
  assert.match(
    promotion,
    /test -f '\$FRONTEND_CANDIDATE_BUILD_DIR\/server\.js'/,
  );
  assert.ok(
    promotion.indexOf("frontend_root_standalone_is_valid") <
      promotion.indexOf('frontend_slot_is_valid "$FRONTEND_LIVE_BUILD_DIR"'),
    "pointerless root recovery must be classified before legacy .next",
  );
  assert.match(
    promotion,
    /Refusing frontend promotion because no validated rollback runtime is available/,
  );
  const pointerMutation = promotion.indexOf(" point ");
  const rollbackArmed = promotion.indexOf("FRONTEND_PROMOTED=true");
  const pointerAssertion = promotion.indexOf(
    "Frontend promotion pointer mismatch",
  );
  assert.ok(
    promotion.indexOf("no validated rollback runtime") < pointerMutation,
    "promotion must prove rollback availability before pointer mutation",
  );
  assert.ok(pointerMutation >= 0, "promotion must mutate the pointer");
  assert.ok(
    pointerMutation < rollbackArmed && rollbackArmed < pointerAssertion,
    "rollback must be armed immediately after pointer mutation",
  );
});

test("failed frontend verification requires a checked rollback", () => {
  const rollback = section(
    "verify_restored_frontend_build() {",
    "discard_previous_frontend_build() {",
  );
  assert.match(rollback, /actual_pointer/);
  assert.match(rollback, /Frontend rollback pointer mismatch/);
  assert.match(rollback, /verify_service_active/);
  assert.match(rollback, /restored frontend login/);
  assert.match(rollback, /restored frontend Auth\.js CSRF route/);
  assert.match(rollback, /restored frontend Auth\.js providers route/);
  assert.match(rollback, /smoke_check_frontend_static_asset/);
  assert.match(rollback, /restored same-origin backend proxy/);
  assert.match(rollback, /return 1/);
  assert.doesNotMatch(rollback, /systemctl restart[^\n]*\|\| true/);
  assert.match(rollback, /rm -f -- '\$FRONTEND_ACTIVE_BUILD_POINTER'/);
  assert.match(rollback, /FRONTEND_ACTIVE_POINTER_PRESENT/);

  const exitHandler = section(
    "handle_deploy_exit() {",
    "trap handle_deploy_exit EXIT",
  );
  assert.match(exitHandler, /rollback_failed=true/);
  assert.ok(
    exitHandler.indexOf("rollback_configuration") <
      exitHandler.lastIndexOf("verify_restored_frontend_build"),
    "the restored frontend must be verified after configuration restoration",
  );
  assert.match(
    exitHandler,
    /CONFIG_ROLLBACK_ATTEMPTED[\s\S]*select_frontend_build_slots[\s\S]*verify_restored_frontend_build/,
  );
  assert.match(exitHandler, /status=2/);
});

test("emergency dependency repair never mutates a live legacy runtime", () => {
  const emergencyBuild = section(
    "prepare_frontend_candidate_build_on_host() {",
    "prepare_frontend_candidate_build() {",
  );
  assert.match(emergencyBuild, /active_runtime_is_standalone/);
  assert.match(emergencyBuild, /lock marker is missing/);
  assert.match(emergencyBuild, /dependency lock changed/);
  assert.match(emergencyBuild, /npm ci[\s\S]*--loglevel=error/);
  assert.match(
    emergencyBuild,
    /active legacy frontend shares node_modules and must remain untouched/,
  );
});

test("removing a worker drop-in always schedules a systemd reload", () => {
  const removal = section(
    "remove_obsolete_primary_worker_dropins() {",
    "validate_primary_worker_launcher() {",
  );
  assert.match(removal, /sudo rm -f -- "\$target"[\s\S]*SYSTEMD_RELOAD_REQUIRED=true/);
});

test("configuration rollback is scoped away from backend during frontend-only deploys", () => {
  const restartAfterRestore = section(
    "restart_services_after_restore() {",
    "rollback_configuration() {",
  );
  assert.match(
    restartAfterRestore,
    /\[\[ "\$DEPLOY_BACKEND" == "true" \]\][\s\S]*\$BACKEND_SERVICE_NAME/,
  );
  assert.match(
    restartAfterRestore,
    /\[\[ "\$DEPLOY_FRONTEND" == "true" \]\][\s\S]*\$FRONTEND_SERVICE_NAME/,
  );
});

test("frontend launcher supports standalone slots and legacy rollback slots", () => {
  assert.match(launcher, /resolve-launch/);
  assert.match(launcher, /standalone-slot\|standalone-root-recovery/);
  assert.match(
    launcher,
    /unset NEXT_DIST_DIR[\s\S]*node "\$ACTIVE_RUNTIME_ROOT\/server\.js"/,
  );
  assert.ok(
    launcher.indexOf("unset NEXT_DIST_DIR") <
      launcher.indexOf('export NEXT_DIST_DIR="$ACTIVE_BUILD_DIRECTORY"'),
  );
  assert.match(launcher, /node "\$ACTIVE_RUNTIME_ROOT\/server\.js"/);
  assert.match(launcher, /node_modules\/\.bin\/next/);
  assert.match(launcher, /\bstart\b/);
});
