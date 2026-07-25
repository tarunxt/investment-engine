// This file is overwritten on the production host immediately before the
// frontend build. The committed values keep local and CI builds deterministic.
export const GENERATED_BUILD_SHA = "development";
export const GENERATED_BUILD_TIMESTAMP: string | null = null;
