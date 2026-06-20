export const BULLPEN_BIN_CANDIDATES = Array.from(
  new Set(
    [
      process.env.BULLPEN_BIN,
      process.env.HOME ? `${process.env.HOME}/.bullpen/bin/bullpen` : null,
      "/opt/homebrew/bin/bullpen",
      "/usr/local/bin/bullpen",
      "/home/investor/.bullpen/bin/bullpen",
      "/home/appuser/.bullpen/bin/bullpen",
      "bullpen",
    ].filter((candidate): candidate is string => Boolean(candidate)),
  ),
);

export function buildBullpenProcessEnv({
  readOnly = false,
}: {
  readOnly?: boolean;
} = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
  };

  if (readOnly) {
    env.BULLPEN_READ_ONLY = "true";
    env.BULLPEN_NON_INTERACTIVE = "true";
  }

  const configuredHome =
    process.env.BULLPEN_HOME || process.env.BULLPEN_CREDENTIALS_HOME;
  if (configuredHome) {
    env.HOME = configuredHome;
  }

  return env;
}

export function parseBullpenJsonOutput(stdout: string) {
  const sanitized = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("Update available:"))
    .join("\n");

  return JSON.parse(sanitized);
}
