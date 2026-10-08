import { apiService } from "@/services/api";
import { URLs } from "@/lib/urls";
import type { AuditComparison, AuditFormula, AuditVerification, AuditVerifyRequest } from "@/types/recommendationAudit";
import type { RunResponse } from "@/types/api";

export async function auditResponseHashes(runs: RunResponse[]) {
  const pairs = await Promise.all(runs.flatMap(run => run.run_jobs).map(async link => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(link.job.response ?? ""));
    return [link.job_id, Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")] as const;
  }));
  return Object.fromEntries(pairs);
}

const endpoint = () => `${URLs.runs.create()}/recommendation-audit`;
export const recommendationAuditEnabled = process.env.NEXT_PUBLIC_RECOMMENDATION_AUDIT_ENABLED === "true";
export const recommendationAuditApi = {
  comparison(params: { run_id: number; market: string; symbol: string; exchange: string }, signal?: AbortSignal) {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return apiService.get<AuditComparison>(`${endpoint()}/comparison?${query}`, { signal });
  },
  materialize(run_id: number, signal?: AbortSignal) {
    return apiService.post<{ captured: number }>(`${endpoint()}/materialize`, { run_id }, { signal });
  },
  async capture(run_ids: number[], technical_run_id: number | null, formula: AuditFormula, signal?: AbortSignal) {
    const ids = [...new Set([...run_ids, ...(technical_run_id ? [technical_run_id] : [])])];
    const runs = await Promise.all(ids.map(id => apiService.getRun(id, { signal })));
    const expected_response_hashes = await auditResponseHashes(runs);
    signal?.throwIfAborted();
    return apiService.post<{ decision_ids: string[] }>(`${endpoint()}/calculations`, { run_ids, technical_run_id, formula, expected_response_hashes }, { signal });
  },
  verify(request: AuditVerifyRequest, signal?: AbortSignal) {
    return apiService.post<AuditVerification>(`${endpoint()}/verifications`, request, { signal });
  },
  status(id: string, signal?: AbortSignal) {
    return apiService.get<AuditVerification>(`${endpoint()}/verifications/${encodeURIComponent(id)}`, { signal });
  },
  cancel(id: string) { return apiService.post<AuditVerification>(`${endpoint()}/verifications/${encodeURIComponent(id)}/cancel`, {}); },
};
