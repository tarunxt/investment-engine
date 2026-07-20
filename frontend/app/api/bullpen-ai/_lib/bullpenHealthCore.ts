import { access } from "node:fs/promises";
import path from "node:path";

export type BullpenCliFailureClassification =
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "NETWORK_ERROR"
  | "BINARY_MISSING"
  | "JSON_PARSE_ERROR"
  | "TIMEOUT"
  | "UNKNOWN_ERROR";

export type BullpenCliHealth = {
  ok: boolean;
  classification: BullpenCliFailureClassification | null;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  signal: string | null;
  commandPath: string | null;
  attemptedPaths?: string[];
  timedOut: boolean;
  timestamp: string;
  credentialHome: string | null;
  credentialArtifact?: string | null;
  message: string;
  actionNeeded: string | null;
};

export type BullpenCliExecSuccess = {
  stdout: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: string | null;
};

export type BullpenCliExecOptions = {
  env: Record<string, string | undefined>;
  timeoutMs: number;
  maxBuffer: number;
};

export type BullpenCliExecImplementation = (
  file: string,
  args: string[],
  options: BullpenCliExecOptions,
) => Promise<BullpenCliExecSuccess>;

export type BullpenCliProcessError = Error & {
  stdout?: string;
  stderr?: string;
  code?: number | string | null;
  signal?: string | null;
  killed?: boolean;
};

export type BullpenCliHealthCheckResult<TPayload = unknown> = {
  ok: boolean;
  health: BullpenCliHealth;
  payload: TPayload | null;
};

const OUTPUT_PREVIEW_LIMIT = 4_000;
const TOKEN_LABEL_PATTERNS = [
  /\b(authorization|bearer|token|jwt|secret|session|cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|credential(?:s)?|turnkey(?:[_-]?bundle)?|rpc[_-]?url)\b\s*[:=]\s*["']?([A-Za-z0-9._~+/:?-]{8,})["']?/gi,
  /\b(authorization|bearer|token|jwt|secret|session|cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|credential(?:s)?|turnkey(?:[_-]?bundle)?|rpc[_-]?url)\b\s+([A-Za-z0-9._~+/:?-]{8,})/gi,
];
const JWT_PATTERN = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const AUTHED_URL_PATTERN = /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const QUERY_TOKEN_PATTERN =
  /([?&](?:token|jwt|auth|authorization|session|secret|api[_-]?key|refresh[_-]?token)=)([^&\s]+)/gi;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9._~-]{24,}\b/g;
const AUTH_REQUIRED_PATTERNS = [
  /\bauth(?:entication)? (?:expired|required|failed|invalid)\b/i,
  /\bauthori[sz](?:ation|ed)? (?:expired|required|failed|invalid)\b/i,
  /\bauth_refresh_rejected_login_required\b/i,
  /\bauth\.refresh_rejected\b/i,
  /\brefresh_token_rejected\b/i,
  /\blogin required\b/i,
  /\brequires_login\b/i,
  /\brequires_auth\b/i,
  /\blogin_required\b/i,
  /\bunauthenticated\b/i,
  /\binvalid refresh token\b/i,
  /\brefresh token rejected\b/i,
  /\bsession expired\b/i,
  /\bre-?login\b/i,
  /\bjwt expired\b/i,
  /\brun:? bullpen login\b/i,
];
const AUTH_EXPIRED_PATTERNS = [
  /\bauth_refresh_rejected_login_required\b/i,
  /\bauth\.refresh_rejected\b/i,
  /\brefresh_token_rejected\b/i,
  /\binvalid refresh token\b/i,
  /\brefresh token rejected\b/i,
  /\bsession expired\b/i,
  /\bjwt expired\b/i,
];
const NETWORK_PATTERNS = [
  /\bnetwork error\b/i,
  /\bconnection (?:reset|refused|timed out|closed)\b/i,
  /\bgetaddrinfo\b/i,
  /\btemporary failure in name resolution\b/i,
  /\bdns\b/i,
  /\beconn(?:refused|reset|timedout)\b/i,
  /\betimedout\b/i,
  /\benotfound\b/i,
  /\btls\b/i,
  /\bfetch failed\b/i,
  /\bservice unavailable\b/i,
  /\bgateway timeout\b/i,
];
const BINARY_MISSING_PATTERNS = [
  /\benoent\b/i,
  /\bcommand not found\b/i,
  /\bno such file or directory\b/i,
  /\bexecutable file not found\b/i,
  /\bnot found\b/i,
];
const BULLPEN_CREDENTIAL_FILE_NAMES = [
  "credentials.json.enc",
  "credentials.json",
] as const;

function truncateText(value: string) {
  if (value.length <= OUTPUT_PREVIEW_LIMIT) return value;
  const omitted = value.length - OUTPUT_PREVIEW_LIMIT;
  return `${value.slice(0, OUTPUT_PREVIEW_LIMIT)}\n...[truncated ${omitted} chars]`;
}

function looksTokenLike(value: string) {
  if (/^0x[a-f0-9]{40,}$/i.test(value)) {
    return false;
  }
  return (
    value.length >= 24 &&
    /[A-Za-z]/.test(value) &&
    /\d/.test(value) &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

export function redactBullpenSensitiveText(value: string | null | undefined) {
  if (!value) return null;

  let redacted = value;

  for (const pattern of TOKEN_LABEL_PATTERNS) {
    redacted = redacted.replace(pattern, (match, label) =>
      match.startsWith(label)
        ? `${label}: [REDACTED]`
        : `${label} [REDACTED]`,
    );
  }

  redacted = redacted.replace(JWT_PATTERN, "[REDACTED_JWT]");
  redacted = redacted.replace(
    AUTHED_URL_PATTERN,
    (_match, prefix: string) => `${prefix}[REDACTED]@`,
  );
  redacted = redacted.replace(
    QUERY_TOKEN_PATTERN,
    (_, prefix: string) => `${prefix}[REDACTED]`,
  );
  redacted = redacted.replace(LONG_TOKEN_PATTERN, (candidate) =>
    looksTokenLike(candidate) ? "[REDACTED_TOKEN]" : candidate,
  );

  return truncateText(redacted);
}

export function sanitizeBullpenJsonOutput(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("Update available:"))
    .join("\n");
}

export function parseBullpenCliJsonOutput(stdout: string) {
  return JSON.parse(sanitizeBullpenJsonOutput(stdout));
}

function normalizeCombinedOutput({
  stdout,
  stderr,
  errorMessage,
}: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}) {
  return [stderr, stdout, errorMessage]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n")
    .toLowerCase();
}

function buildBinaryMissingMessage(commandPath: string | null, attemptedPaths: string[]) {
  const checked =
    attemptedPaths.length > 0
      ? ` Checked ${attemptedPaths.join(", ")}.`
      : commandPath
        ? ` Checked ${commandPath}.`
        : "";

  return {
    message: `Bullpen CLI binary is missing.${checked} Install Bullpen or fix BULLPEN_BIN.`,
    actionNeeded:
      "Install Bullpen on the server or point BULLPEN_BIN at a working executable.",
  };
}

function buildFailureMessage({
  classification,
  credentialHome,
  credentialArtifact,
  commandPath,
  attemptedPaths,
}: {
  classification: BullpenCliFailureClassification;
  credentialHome: string | null;
  credentialArtifact: string | null;
  commandPath: string | null;
  attemptedPaths: string[];
}) {
  const credentialDetail = credentialArtifact
    ? ` Detected ${credentialArtifact} in that HOME.`
    : "";
  switch (classification) {
    case "AUTH_REQUIRED":
      return {
        message: `Bullpen CLI auth is required for HOME=${credentialHome || "unknown"}.${credentialDetail} Re-login on server.`,
        actionNeeded:
          "sudo -u investor -H /usr/local/bin/bullpen login --no-browser",
      };
    case "AUTH_EXPIRED":
      return {
        message: `Bullpen CLI auth appears expired for HOME=${credentialHome || "unknown"}.${credentialDetail} Re-login on server.`,
        actionNeeded:
          "sudo -u investor -H /usr/local/bin/bullpen login --no-browser",
      };
    case "NETWORK_ERROR":
      return {
        message:
          "Bullpen CLI hit a network issue while reading live wallet positions.",
        actionNeeded:
          "Check outbound network, DNS, and Bullpen API reachability on the server, then retry.",
      };
    case "BINARY_MISSING":
      return buildBinaryMissingMessage(commandPath, attemptedPaths);
    case "JSON_PARSE_ERROR":
      return {
        message:
          "Bullpen CLI returned malformed JSON for live wallet positions.",
        actionNeeded:
          "Inspect Bullpen CLI stdout/stderr on the server, then retry or upgrade the CLI.",
      };
    case "TIMEOUT":
      return {
        message:
          "Bullpen CLI timed out while reading live wallet positions.",
        actionNeeded:
          "Check Bullpen session/network responsiveness on the server, then retry.",
      };
    default:
      return {
        message: `Bullpen CLI failed unexpectedly${commandPath ? ` at ${commandPath}` : ""}.`,
        actionNeeded:
          "Inspect Bullpen CLI stderr/stdout on the server and retry.",
      };
  }
}

function toExitCode(value: number | string | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function detectBinaryMissing(text: string, commandPath: string | null) {
  return (
    BINARY_MISSING_PATTERNS.some((pattern) => pattern.test(text)) &&
    (!commandPath || !/login|auth|session/i.test(text))
  );
}

export function classifyBullpenCliFailure({
  stdout,
  stderr,
  exitCode,
  signal,
  commandPath,
  attemptedPaths = [],
  timedOut = false,
  timestamp,
  credentialHome,
  credentialArtifact = null,
  errorMessage,
}: {
  stdout?: string | null;
  stderr?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  commandPath?: string | null;
  attemptedPaths?: string[];
  timedOut?: boolean;
  timestamp: string;
  credentialHome: string | null;
  credentialArtifact?: string | null;
  errorMessage?: string | null;
}): BullpenCliHealth {
  const combined = normalizeCombinedOutput({ stdout, stderr, errorMessage });
  let classification: BullpenCliFailureClassification = "UNKNOWN_ERROR";

  if (timedOut) {
    classification = "TIMEOUT";
  } else if (detectBinaryMissing(combined, commandPath || null)) {
    classification = "BINARY_MISSING";
  } else if (AUTH_EXPIRED_PATTERNS.some((pattern) => pattern.test(combined))) {
    classification = "AUTH_EXPIRED";
  } else if (AUTH_REQUIRED_PATTERNS.some((pattern) => pattern.test(combined))) {
    classification = "AUTH_REQUIRED";
  } else if (NETWORK_PATTERNS.some((pattern) => pattern.test(combined))) {
    classification = "NETWORK_ERROR";
  }

  const failureMessage = buildFailureMessage({
    classification,
    credentialHome,
    credentialArtifact,
    commandPath: commandPath || null,
    attemptedPaths,
  });

  return {
    ok: false,
    classification,
    stdout: redactBullpenSensitiveText(stdout),
    stderr: redactBullpenSensitiveText(stderr || errorMessage || null),
    exitCode: exitCode ?? null,
    signal: signal ?? null,
    commandPath: commandPath || null,
    attemptedPaths,
    timedOut,
    timestamp,
    credentialHome,
    credentialArtifact,
    message: failureMessage.message,
    actionNeeded: failureMessage.actionNeeded,
  };
}

export function buildBullpenCliSuccessHealth({
  stdout,
  stderr,
  exitCode = 0,
  signal = null,
  commandPath,
  attemptedPaths = [],
  timestamp,
  credentialHome,
  credentialArtifact = null,
}: {
  stdout: string;
  stderr?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  commandPath: string;
  attemptedPaths?: string[];
  timestamp: string;
  credentialHome: string | null;
  credentialArtifact?: string | null;
}): BullpenCliHealth {
  return {
    ok: true,
    classification: null,
    stdout: redactBullpenSensitiveText(stdout),
    stderr: redactBullpenSensitiveText(stderr || null),
    exitCode: exitCode ?? 0,
    signal,
    commandPath,
    attemptedPaths,
    timedOut: false,
    timestamp,
    credentialHome,
    credentialArtifact,
    message: "Bullpen CLI live wallet sync is healthy.",
    actionNeeded: null,
  };
}

export function buildBullpenCliJsonParseHealth({
  stdout,
  stderr,
  commandPath,
  attemptedPaths = [],
  timestamp,
  credentialHome,
  credentialArtifact = null,
}: {
  stdout: string;
  stderr?: string | null;
  commandPath: string;
  attemptedPaths?: string[];
  timestamp: string;
  credentialHome: string | null;
  credentialArtifact?: string | null;
}) {
  const details = buildFailureMessage({
    classification: "JSON_PARSE_ERROR",
    credentialHome,
    credentialArtifact,
    commandPath,
    attemptedPaths,
  });

  return {
    ok: false,
    classification: "JSON_PARSE_ERROR" as const,
    stdout: redactBullpenSensitiveText(stdout),
    stderr: redactBullpenSensitiveText(stderr || null),
    exitCode: 0,
    signal: null,
    commandPath,
    attemptedPaths,
    timedOut: false,
    timestamp,
    credentialHome,
    credentialArtifact,
    message: details.message,
    actionNeeded: details.actionNeeded,
  };
}

export function isBullpenCliTimeout(error: unknown) {
  if (!(error instanceof Error)) return false;
  const processError = error as BullpenCliProcessError;
  return Boolean(processError.killed) || /timed out/i.test(processError.message);
}

async function detectBullpenCredentialArtifact(credentialHome: string | null) {
  if (!credentialHome) return null;

  for (const candidate of BULLPEN_CREDENTIAL_FILE_NAMES) {
    try {
      await access(path.join(credentialHome, candidate));
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

export async function runBullpenCliHealthCheckWithExecutor<TPayload>({
  commandCandidates,
  env,
  execFileImpl,
  parseJsonOutput,
  timeoutMs = 30_000,
  maxBuffer = 10 * 1024 * 1024,
  now = () => new Date().toISOString(),
}: {
  commandCandidates: string[];
  env: Record<string, string | undefined>;
  execFileImpl: BullpenCliExecImplementation;
  parseJsonOutput: (stdout: string) => TPayload;
  timeoutMs?: number;
  maxBuffer?: number;
  now?: () => string;
}): Promise<BullpenCliHealthCheckResult<TPayload>> {
  const attemptedPaths: string[] = [];
  const credentialHome = env.HOME || null;
  const credentialArtifact = await detectBullpenCredentialArtifact(credentialHome);
  let lastMissingError: BullpenCliProcessError | null = null;

  for (const candidate of commandCandidates) {
    attemptedPaths.push(candidate);
    const timestamp = now();

    try {
      const result = await execFileImpl(
        candidate,
        ["polymarket", "positions", "--output", "json"],
        {
          env,
          timeoutMs,
          maxBuffer,
        },
      );
      const stdout = result.stdout || "";
      const stderr = result.stderr || "";

      try {
        const payload = parseJsonOutput(stdout);
        return {
          ok: true,
          health: buildBullpenCliSuccessHealth({
            stdout,
            stderr,
            exitCode: result.exitCode ?? 0,
            signal: result.signal ?? null,
            commandPath: candidate,
            attemptedPaths,
            timestamp,
            credentialHome,
            credentialArtifact,
          }),
          payload,
        };
      } catch {
        return {
          ok: false,
          health: buildBullpenCliJsonParseHealth({
            stdout,
            stderr,
            commandPath: candidate,
            attemptedPaths,
            timestamp,
            credentialHome,
            credentialArtifact,
          }),
          payload: null,
        };
      }
    } catch (error) {
      const processError = error as BullpenCliProcessError;
      const failure = classifyBullpenCliFailure({
        stdout: processError.stdout || null,
        stderr: processError.stderr || null,
        exitCode: toExitCode(processError.code),
        signal: processError.signal || null,
        commandPath: candidate,
        attemptedPaths,
        timedOut: isBullpenCliTimeout(processError),
        timestamp,
        credentialHome,
        credentialArtifact,
        errorMessage: processError.message || null,
      });

      if (
        failure.classification === "BINARY_MISSING" &&
        attemptedPaths.length < commandCandidates.length
      ) {
        lastMissingError = processError;
        continue;
      }

      return {
        ok: false,
        health: failure,
        payload: null,
      };
    }
  }

  const timestamp = now();
  return {
    ok: false,
    health: classifyBullpenCliFailure({
      stdout: lastMissingError?.stdout || null,
      stderr: lastMissingError?.stderr || null,
      exitCode: toExitCode(lastMissingError?.code),
      signal: lastMissingError?.signal || null,
      commandPath: commandCandidates[0] || null,
      attemptedPaths,
      timedOut: false,
      timestamp,
      credentialHome,
      credentialArtifact,
      errorMessage:
        lastMissingError?.message || "Bullpen CLI binary could not be found.",
    }),
    payload: null,
  };
}
