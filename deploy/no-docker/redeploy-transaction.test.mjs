import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const realNode = process.execPath;

async function executable(filePath, source) {
  await writeFile(filePath, source, "utf8");
  await chmod(filePath, 0o755);
}

async function createHarness() {
  const root = await mkdtemp("/tmp/investor-deploy-transaction-");
  const releaseRoot = path.join(root, "release");
  const srvRoot = path.join(root, "srv");
  const appRoot = path.join(srvRoot, "investor");
  const frontendRoot = path.join(releaseRoot, "frontend");
  const fakeBin = path.join(root, "bin");
  const logPath = path.join(root, "commands.log");
  const systemdRoot = path.join(root, "systemd");
  const nginxRoot = path.join(root, "nginx");
  await mkdir(frontendRoot, { recursive: true });
  await mkdir(srvRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(systemdRoot, { recursive: true });
  await mkdir(path.join(nginxRoot, "sites-available"), { recursive: true });
  await mkdir(path.join(nginxRoot, "sites-enabled"), { recursive: true });
  await symlink(releaseRoot, appRoot);
  await cp(path.join(repositoryRoot, "deploy"), path.join(releaseRoot, "deploy"), {
    recursive: true,
  });
  await cp(path.join(repositoryRoot, "scripts"), path.join(releaseRoot, "scripts"), {
    recursive: true,
  });
  await cp(
    path.join(repositoryRoot, "frontend", "package-lock.json"),
    path.join(frontendRoot, "package-lock.json"),
  );

  const activeSlot = path.join(frontendRoot, ".next");
  await mkdir(path.join(activeSlot, ".next", "static"), { recursive: true });
  await writeFile(path.join(activeSlot, "server.js"), "previous-runtime\n");
  await writeFile(path.join(activeSlot, ".next", "BUILD_ID"), "previous\n");
  await writeFile(path.join(activeSlot, "active-marker"), "previous-untouched\n");
  await writeFile(path.join(frontendRoot, ".next-active-dir"), ".next\n");

  const artifactRoot = path.join(root, "artifact-root");
  await mkdir(path.join(artifactRoot, ".next", "static"), { recursive: true });
  await writeFile(path.join(artifactRoot, "server.js"), "candidate-runtime\n");
  await writeFile(path.join(artifactRoot, ".next", "BUILD_ID"), "candidate\n");
  await writeFile(
    path.join(artifactRoot, ".next", "static", "candidate.js"),
    "candidate\n",
  );
  await writeFile(path.join(artifactRoot, "candidate-marker"), "candidate\n");
  const artifact = path.join(root, "frontend.tar.gz");
  await execFileAsync("tar", ["-czf", artifact, "-C", artifactRoot, "."]);
  const artifactBytes = await readFile(artifact);
  const checksum = createHash("sha256").update(artifactBytes).digest("hex");
  await writeFile(`${artifact}.sha256`, `${checksum}  frontend.tar.gz\n`);

  const frontendEnv = path.join(root, "frontend.env");
  await writeFile(
    frontendEnv,
    [
      "NEXTAUTH_URL=http://127.0.0.1:3000",
      "NEXTAUTH_SECRET=test-secret-with-sufficient-length",
      "NEXT_PUBLIC_FRONTEND_URL=https://cred-x.test",
      "NEXT_PUBLIC_API_URL=https://api.cred-x.test",
    ].join("\n"),
  );

  await executable(
    path.join(fakeBin, "sudo"),
    `#!/usr/bin/env bash
set -e
while [[ "\${1:-}" == "-u" || "\${1:-}" == "-H" || "\${1:-}" == "--" ]]; do
  if [[ "$1" == "-u" ]]; then shift 2; else shift; fi
done
if [[ "\${1:-}" == "bash" && "\${2:-}" == "-lc" ]]; then
  exec bash -c "export PATH='${fakeBin}':\\$PATH; \${3}"
fi
exec "$@"
`,
  );
  await executable(
    path.join(fakeBin, "systemctl"),
    `#!/usr/bin/env bash
echo "systemctl $*" >> "${logPath}"
case "\${1:-}" in
  is-active|is-enabled)
    unit="\${@: -1}"
    if [[ "$unit" == *frontend* || "$unit" == nginx ]]; then
      [[ "\${2:-}" == "--quiet" ]] || echo active
      exit 0
    fi
    [[ "\${2:-}" == "--quiet" ]] || echo inactive
    exit 1
    ;;
  cat)
    [[ "\${2:-}" == *frontend* ]]
    ;;
  show)
    echo 0
    ;;
  *)
    exit 0
    ;;
esac
`,
  );
  await executable(
    path.join(fakeBin, "systemd-analyze"),
    `#!/usr/bin/env bash
echo "systemd-analyze $*" >> "${logPath}"
exit 0
`,
  );
  await executable(
    path.join(fakeBin, "nginx"),
    `#!/usr/bin/env bash
echo "nginx $*" >> "${logPath}"
exit 0
`,
  );
  await executable(
    path.join(fakeBin, "node"),
    `#!/usr/bin/env bash
set -e
script="\${1:-}"
if [[ "$script" == *frontend-artifact.mjs ]]; then
  command="\${2:-}"
  frontend_root="\${3:-}"
  case "$command" in
    select)
      active=".next"
      [[ -f "$frontend_root/.next-active-dir" ]] && active="$(tr -d '\\r\\n' < "$frontend_root/.next-active-dir")"
      [[ "$active" == ".next" ]] && printf '.next\\t.next-candidate\\n' || printf '.next-candidate\\t.next\\n'
      ;;
    resolve-launch)
      active="$(tr -d '\\r\\n' < "$frontend_root/.next-active-dir")"
      printf 'standalone-slot\\t%s/%s\\t%s\\n' "$frontend_root" "$active" "$active"
      ;;
    point)
      printf '%s\\n' "\${4}" > "$frontend_root/.next-active-dir"
      ;;
    validate-host)
      test -f "$frontend_root/server.js"
      ;;
    *)
      exit 2
      ;;
  esac
  exit 0
fi
if [[ "$script" == *verify-frontend-artifact-runtime.mjs ]]; then
  exit 0
fi
exec "${realNode}" "$@"
`,
  );
  await executable(
    path.join(fakeBin, "install"),
    `#!/usr/bin/env bash
set -e
source_path=""
target_path=""
while (( "$#" )); do
  case "$1" in
    -D) shift ;;
    -m) shift 2 ;;
    *) [[ -z "$source_path" ]] && source_path="$1" || target_path="$1"; shift ;;
  esac
done
mkdir -p "$(dirname "$target_path")"
cp "$source_path" "$target_path"
`,
  );
  await executable(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
set -e
url=""
headers=""
output=""
write_out=""
while (( "$#" )); do
  case "$1" in
    --dump-header) headers="$2"; shift 2 ;;
    --output|-o) output="$2"; shift 2 ;;
    --write-out|-w) write_out="$2"; shift 2 ;;
    --max-time) shift 2 ;;
    --fail|--silent|--show-error|--location|-f|-s|-S|-L|-fsS) shift ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
body="ok"
case "$url" in
  */api/runtime-fingerprint)
    body='{"build_sha":"candidate-sha"}'
    ;;
  */api/auth/csrf)
    body='{"csrfToken":"test-csrf"}'
    ;;
  */api/auth/providers)
    body='{"credentials":{"id":"credentials","signinUrl":"http://127.0.0.1:3000/api/auth/signin/credentials"}}'
    ;;
  */console/dashboard)
    [[ -n "$headers" ]] && printf 'HTTP/1.1 307 Temporary Redirect\\r\\nLocation: /login?redirectTo=%%2Fconsole%%2Fdashboard\\r\\n\\r\\n' > "$headers"
    write_out="307"
    ;;
  */console/bullpen-ai)
    [[ -n "$headers" ]] && printf 'HTTP/1.1 307 Temporary Redirect\\r\\nLocation: /login?redirectTo=%%2Fconsole%%2Fbullpen-ai\\r\\n\\r\\n' > "$headers"
    write_out="307"
    ;;
  */_next/static/*.css)
    [[ -n "$headers" ]] && printf 'HTTP/1.1 200 OK\\r\\ncontent-type: text/css\\r\\n\\r\\n' > "$headers"
    body='body{}'
    ;;
  */_next/static/*.js)
    [[ -n "$headers" ]] && printf 'HTTP/1.1 200 OK\\r\\ncontent-type: application/javascript\\r\\n\\r\\n' > "$headers"
    body='(()=>{})()'
    ;;
  */login)
    body='<link href="/_next/static/app.css"><script src="/_next/static/app.js"></script>'
    ;;
esac
if [[ -n "$output" && "$output" != "/dev/null" ]]; then
  printf '%s' "$body" > "$output"
elif [[ -z "$output" ]]; then
  printf '%s' "$body"
fi
[[ -n "$write_out" ]] && printf '%s' "$write_out"
`,
  );

  return {
    root,
    appRoot,
    frontendRoot,
    fakeBin,
    logPath,
    systemdRoot,
    nginxRoot,
    frontendEnv,
    artifact,
  };
}

async function runFailure(phase) {
  const harness = await createHarness();
  let result;
  try {
    await execFileAsync(
      "bash",
      [path.join(harness.appRoot, "deploy/no-docker/redeploy.sh"), "frontend-only"],
      {
        env: {
          ...process.env,
          PATH: `${harness.fakeBin}:${process.env.PATH}`,
          APP_ROOT: harness.appRoot,
          APP_USER: process.env.USER,
          FRONTEND_ENV_FILE: harness.frontendEnv,
          FRONTEND_ARTIFACT: harness.artifact,
          EXPECTED_FRONTEND_SHA: "candidate-sha",
          SKIP_GIT_SYNC: "true",
          SYSTEMD_UNIT_ROOT: harness.systemdRoot,
          NGINX_CONFIG_ROOT: harness.nginxRoot,
          SMOKE_RETRIES: "1",
          SMOKE_RETRY_SLEEP_SECONDS: "0",
          SERVICE_STARTUP_RETRIES: "1",
          SERVICE_STARTUP_RETRY_SLEEP_SECONDS: "0",
          SERVICE_STABLE_SECONDS: "0",
          INVESTOR_DEPLOY_TEST_MODE: "true",
          INVESTOR_DEPLOY_TEST_FAIL_PHASE: phase,
        },
      },
    );
    assert.fail(`deployment unexpectedly succeeded for ${phase}`);
  } catch (error) {
    result = error;
  }
  return { harness, result };
}

for (const phase of ["extraction", "host-validation", "candidate-verification"]) {
  test(`pre-promotion ${phase} failure leaves the active slot untouched`, async () => {
    const { harness } = await runFailure(phase);
    assert.equal(
      (await readFile(path.join(harness.frontendRoot, ".next-active-dir"), "utf8")).trim(),
      ".next",
    );
    assert.equal(
      await readFile(path.join(harness.frontendRoot, ".next", "active-marker"), "utf8"),
      "previous-untouched\n",
    );
  });
}

for (const phase of [
  "service-startup",
  "fingerprint-verification",
  "js-css-verification",
  "authjs-verification",
  "dashboard-smoke",
  "bullpen-smoke",
  "backend-proxy-verification",
  "nginx-validation",
]) {
  test(`post-promotion ${phase} failure executes and verifies rollback`, async () => {
    const { harness, result } = await runFailure(phase);
    const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const commands = await readFile(harness.logPath, "utf8").catch(() => "");
    assert.match(combinedOutput, /Restoring the previous frontend build/);
    assert.match(combinedOutput, /Final verification of restored frontend/);
    assert.equal(
      (await readFile(path.join(harness.frontendRoot, ".next-active-dir"), "utf8")).trim(),
      ".next",
    );
    assert.equal(
      await readFile(path.join(harness.frontendRoot, ".next", "active-marker"), "utf8"),
      "previous-untouched\n",
    );
    assert.equal(
      await readFile(
        path.join(harness.frontendRoot, ".next-candidate", "candidate-marker"),
        "utf8",
      ),
      "candidate\n",
    );
    assert.ok(
      commands.match(/systemctl restart investor-frontend/g)?.length >= 2,
      commands,
    );
    assert.doesNotMatch(
      commands,
      /investor-(?:backend|celery-worker|celery-beat)/,
    );
  });
}
