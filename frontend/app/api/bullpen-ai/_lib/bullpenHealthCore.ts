export type BullpenCliFailureClassification =
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
  /\b(authorization|bearer|token|jwt|secret|session|cookie)\b\s*[:=]\s*["']?([A-Za-z0-9._~+/-]{8,})["']?/gi,
  /\b(authorization|bearer|token|jwt|secret|session|cookie)\b\s+([A-Za-z0-9._~+/-]{8,})/gi,
];
const JWT_PATTERN = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const QUERY_TOKEN_PATTERN =
  /([?&](?:token|jwt|auth|authorization|session|secret)=)([^&\s]+)/gi;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9._~-]{24,}\b/g;
const AUTH_PATTERNS = [
  /\bauth(?:entication)? (?:expired|required|failed|invalid)\b/i,
  /\bauthori[sz](?:ation|ed)? (?:expired|required|failed|invalid)\b/i,
  /\blogin required\b/i,
  /\bsession expired\b/i,
  /\bre-?login\b/i,
  /\bjwt expired\b/i,
  /\brun:? bullpen login\b/i,
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

function truncateText(value: string) {
  if (value.length <= OUTPUT_PREVIEW_LIMIT) return value;
  const omitted = value.length - OUTPUT_PREVIEW_LIMIT;
  return `${value.slice(0, OUTPUT_PREVIEW_LIMIT)}\n...[truncated ${omitted} chars]`;
}

function looksTokenLike(value: string) {
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
  commandPath,
  attemptedPaths,
}: {
  classification: BullpenCliFailureClassification;
  credentialHome: string | null;
  commandPath: string | null;
  attemptedPaths: string[];
}) {
  switch (classification) {
    case "AUTH_EXPIRED":
      return {
        message: `Bullpen CLI auth appears expired for HOME=${credentialHome || "unknown"}. Re-login on server.`,
        actionNeeded:
          credentialHome && credentialHome !== "unknown"
            ? `Re-login Bullpen on the server for HOME=${credentialHome}.`
            : "Re-login Bullpen on the server.",
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
  errorMessage?: string | null;
}): BullpenCliHealth {
  const combined = normalizeCombinedOutput({ stdout, stderr, errorMessage });
  let classification: BullpenCliFailureClassification = "UNKNOWN_ERROR";

  if (timedOut) {
    classification = "TIMEOUT";
  } else if (detectBinaryMissing(combined, commandPath || null)) {
    classification = "BINARY_MISSING";
  } else if (AUTH_PATTERNS.some((pattern) => pattern.test(combined))) {
    classification = "AUTH_EXPIRED";
  } else if (NETWORK_PATTERNS.some((pattern) => pattern.test(combined))) {
    classification = "NETWORK_ERROR";
  }

  const failureMessage = buildFailureMessage({
    classification,
    credentialHome,
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
}: {
  stdout: string;
  stderr?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  commandPath: string;
  attemptedPaths?: string[];
  timestamp: string;
  credentialHome: string | null;
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
}: {
  stdout: string;
  stderr?: string | null;
  commandPath: string;
  attemptedPaths?: string[];
  timestamp: string;
  credentialHome: string | null;
}) {
  const details = buildFailureMessage({
    classification: "JSON_PARSE_ERROR",
    credentialHome,
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
    message: details.message,
    actionNeeded: details.actionNeeded,
  };
}

export function isBullpenCliTimeout(error: unknown) {
  if (!(error instanceof Error)) return false;
  const processError = error as BullpenCliProcessError;
  return Boolean(processError.killed) || /timed out/i.test(processError.message);
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
      errorMessage:
        lastMissingError?.message || "Bullpen CLI binary could not be found.",
    }),
    payload: null,
  };
}
