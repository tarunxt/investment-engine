"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  AlertTriangle,
  Download,
  Loader2,
  ShieldAlert,
  Upload,
  X,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatUnknownError } from "@/lib/apiErrors";
import { cn } from "@/lib/utils";
import { APIError, apiService } from "@/services/api";
import type {
  BullpenAutoLiveSettings,
  BullpenAutoLiveSummaryResponse,
} from "@/types/api";

import {
  BULLPEN_AI_AUTO_LIVE_GUARDRAIL_FIELDS,
  BULLPEN_AI_AUTO_LIVE_GUARDRAIL_SECTIONS,
  BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS,
  bullpenAiAutoLiveSettingsToDraft,
  formatBullpenAiAutoLiveGuardrailValue,
  validateBullpenAiAutoLiveGuardrailDraft,
  type BullpenAiAutoLiveGuardrailDraft,
} from "./bullpenAiAutoLiveRiskGuardrails";

type ToastState = {
  kind: "success" | "error";
  message: string;
} | null;

type BullpenAiAutoLiveRiskGuardrailsDrawerProps = {
  emergencyStopped: boolean;
  open: boolean;
  settings: BullpenAutoLiveSettings | null;
  settingsLoading: boolean;
  onClose: () => void;
  onSummaryReload: () => Promise<BullpenAutoLiveSummaryResponse | null>;
};

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  return formatUnknownError(error);
}

function getInitialDraft(settings: BullpenAutoLiveSettings | null) {
  return bullpenAiAutoLiveSettingsToDraft(
    settings ?? BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS,
  );
}

export function BullpenAiAutoLiveRiskGuardrailsDrawer({
  emergencyStopped,
  open,
  settings,
  settingsLoading,
  onClose,
  onSummaryReload,
}: BullpenAiAutoLiveRiskGuardrailsDrawerProps) {
  const [draft, setDraft] = useState<BullpenAiAutoLiveGuardrailDraft>(() =>
    getInitialDraft(settings),
  );
  const [enableLiveConfirmation, setEnableLiveConfirmation] = useState("");
  const [resettingBackend, setResettingBackend] = useState(false);
  const [saving, setSaving] = useState(false);
  const [emergencyBusy, setEmergencyBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [lastImportedFileName, setLastImportedFileName] = useState<string | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const validation = useMemo(
    () => validateBullpenAiAutoLiveGuardrailDraft(draft),
    [draft],
  );

  const currentSettings = settings ?? BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS;
  const currentEmergencyStop = settings?.emergency_stop ?? emergencyStopped;
  const settingsUnavailable = !settingsLoading && !settings;
  const hasBlockingValidation = Object.keys(validation.fieldErrors).length > 0;
  const dangerousLiveEnable =
    draft.dry_run === false && draft.allow_live_execution === true;
  const liveConfirmationValid = !dangerousLiveEnable
    ? true
    : enableLiveConfirmation.trim() === "ENABLE LIVE";

  const fieldValuesChanged = useMemo(() => {
    const changed = new Set<keyof BullpenAutoLiveSettings>();
    const currentDraft = bullpenAiAutoLiveSettingsToDraft(currentSettings);

    for (const field of BULLPEN_AI_AUTO_LIVE_GUARDRAIL_FIELDS) {
      if (draft[field.key] !== currentDraft[field.key]) {
        changed.add(field.key);
      }
    }

    return changed;
  }, [currentSettings, draft]);

  const formErrors = useMemo(() => {
    const errors = [...validation.formErrors];

    if (dangerousLiveEnable && !liveConfirmationValid) {
      errors.push(
        'Type "ENABLE LIVE" exactly before saving settings that disable dry-run and enable live execution.',
      );
    }

    return errors;
  }, [dangerousLiveEnable, liveConfirmationValid, validation.formErrors]);

  function showToast(kind: "success" | "error", message: string) {
    setToast({ kind, message });
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 4000);
  }

  function updateDraftValue(
    key: keyof BullpenAutoLiveSettings,
    value: string | boolean,
  ) {
    setDraft((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function handleCancel() {
    setDraft(getInitialDraft(settings));
    setEnableLiveConfirmation("");
    setLastImportedFileName(null);
    showToast("success", "Unsaved changes were discarded.");
  }

  function handleResetSafeDefaults() {
    setDraft(
      bullpenAiAutoLiveSettingsToDraft(BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS),
    );
    setEnableLiveConfirmation("");
    setLastImportedFileName(null);
    showToast(
      "success",
      "Safe defaults loaded into the editor. Save to apply them to the bot.",
    );
  }

  async function handleSave() {
    if (settingsUnavailable) {
      showToast(
        "error",
        "Backend settings are unavailable right now. Reload the console before saving.",
      );
      return;
    }

    if (!validation.settings || hasBlockingValidation || !liveConfirmationValid) {
      showToast("error", "Fix the validation issues before saving.");
      return;
    }

    setSaving(true);
    try {
      await apiService.updateBullpenAutoLiveSettings(validation.settings);
      const nextSummary = await onSummaryReload();
      setDraft(getInitialDraft(nextSummary?.settings ?? validation.settings));
      setEnableLiveConfirmation("");
      setLastImportedFileName(null);
      showToast("success", "Risk guardrails saved and reloaded from the backend.");
    } catch (error) {
      showToast("error", normalizeError(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleResetBackendDefaults() {
    setResettingBackend(true);
    try {
      const nextSettings = await apiService.resetBullpenAutoLiveSettings();
      const nextSummary = await onSummaryReload();
      setDraft(getInitialDraft(nextSummary?.settings ?? nextSettings));
      setEnableLiveConfirmation("");
      setLastImportedFileName(null);
      showToast("success", "Backend settings reset to safe defaults.");
    } catch (error) {
      showToast("error", normalizeError(error));
    } finally {
      setResettingBackend(false);
    }
  }

  async function handleExportJson() {
    if (!validation.settings) {
      showToast("error", "Fix validation issues before exporting JSON.");
      return;
    }

    try {
      const blob = new Blob([JSON.stringify(validation.settings, null, 2)], {
        type: "application/json",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "bullpen-ai-auto-live-risk-guardrails.json";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      showToast("success", "Risk guardrails exported as JSON.");
    } catch (error) {
      showToast("error", normalizeError(error));
    }
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;

    try {
      const rawText = await file.text();
      const parsed = JSON.parse(rawText) as Record<string, unknown>;
      const nextDraft = { ...draft };
      let knownFieldsApplied = 0;

      for (const field of BULLPEN_AI_AUTO_LIVE_GUARDRAIL_FIELDS) {
        if (!(field.key in parsed)) continue;

        const importedValue = parsed[field.key];
        knownFieldsApplied += 1;

        if (field.kind === "boolean") {
          if (typeof importedValue === "boolean") {
            nextDraft[field.key] = importedValue;
            continue;
          }
          if (typeof importedValue === "string") {
            const normalized = importedValue.trim().toLowerCase();
            if (normalized === "true" || normalized === "false") {
              nextDraft[field.key] = normalized === "true";
              continue;
            }
          }
          throw new Error(`${field.label} must be true or false in imported JSON.`);
        }

        if (field.kind === "enum") {
          if (typeof importedValue !== "string") {
            throw new Error(`${field.label} must be a string in imported JSON.`);
          }
          nextDraft[field.key] = importedValue;
          continue;
        }

        if (
          typeof importedValue !== "number" &&
          typeof importedValue !== "string"
        ) {
          throw new Error(`${field.label} must be a number in imported JSON.`);
        }
        nextDraft[field.key] = String(importedValue);
      }

      if (knownFieldsApplied === 0) {
        throw new Error("No supported Bullpen AI Auto-Live guardrail fields were found.");
      }

      setDraft(nextDraft);
      setEnableLiveConfirmation("");
      setLastImportedFileName(file.name);
      showToast("success", `Imported guardrails from ${file.name}.`);
    } catch (error) {
      showToast("error", normalizeError(error));
    }
  }

  async function handleToggleEmergencyStop() {
    setEmergencyBusy(true);
    try {
      if (currentEmergencyStop) {
        await apiService.clearEmergencyStopBullpenAutoLive();
      } else {
        await apiService.emergencyStopBullpenAutoLive();
      }
      await onSummaryReload();
      showToast(
        "success",
        currentEmergencyStop
          ? "Emergency stop cleared."
          : "Emergency stop activated.",
      );
    } catch (error) {
      showToast("error", normalizeError(error));
    } finally {
      setEmergencyBusy(false);
    }
  }

  if (!open) {
    return null;
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <aside
        aria-modal="true"
        aria-labelledby="risk-guardrails-drawer-title"
        className="fixed inset-y-0 right-0 z-[60] flex w-full max-w-[960px] flex-col border-l border-slate-200 bg-white shadow-2xl"
        role="dialog"
      >
        <div className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex items-start justify-between gap-4 px-6 py-5 sm:px-8">
            <div className="space-y-2">
              <div className="inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-700">
                Risk Guardrails
              </div>
              <div>
                <h2
                  className="text-2xl font-bold tracking-tight text-slate-950"
                  id="risk-guardrails-drawer-title"
                >
                  Bullpen AI Auto-Live Guardrails
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                  Every bot-level risk control is editable here. Changes save to
                  the backend settings store, not environment variables only.
                </p>
              </div>
            </div>
            <Button
              aria-label="Close risk guardrails"
              className="rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              onClick={onClose}
              size="icon-sm"
              variant="outline"
            >
              <X className="size-4" />
            </Button>
          </div>
          <div className="px-6 pb-5 sm:px-8">
            <div
              className={cn(
                "rounded-[26px] border px-4 py-4",
                currentEmergencyStop
                  ? "border-rose-300 bg-rose-50"
                  : "border-slate-200 bg-slate-50/80",
              )}
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                    <ShieldAlert
                      className={cn(
                        "size-4",
                        currentEmergencyStop
                          ? "text-rose-600"
                          : "text-slate-500",
                      )}
                    />
                    Emergency Stop
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Always accessible. This writes immediately to the bot state
                    and blocks all new automation runs when active.
                  </p>
                </div>
                <Button
                  className={cn(
                    "rounded-full px-5",
                    currentEmergencyStop
                      ? "bg-white text-rose-700 hover:bg-rose-100"
                      : "bg-rose-600 text-white hover:bg-rose-500",
                  )}
                  disabled={emergencyBusy}
                  onClick={handleToggleEmergencyStop}
                >
                  {emergencyBusy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : currentEmergencyStop ? (
                    "Clear Emergency Stop"
                  ) : (
                    "Activate Emergency Stop"
                  )}
                </Button>
              </div>
            </div>

            {!draft.dry_run ? (
              <Alert className="mt-4 border-amber-200 bg-amber-50 text-amber-900">
                <AlertTriangle className="size-4" />
                <AlertTitle>Dry-run is off</AlertTitle>
                <AlertDescription>
                  The bot is no longer restricted to simulation mode. Review all
                  hard blocks before you save.
                </AlertDescription>
              </Alert>
            ) : null}

            {draft.allow_live_execution ? (
              <Alert className="mt-4 border-rose-300 bg-rose-50 text-rose-900">
                <ShieldAlert className="size-4" />
                <AlertTitle>Live execution path enabled</AlertTitle>
                <AlertDescription>
                  Allowing live execution can route real orders if the rest of
                  the guardrails and runtime gates are green.
                </AlertDescription>
              </Alert>
            ) : null}

            {dangerousLiveEnable ? (
              <div className="mt-4 rounded-[24px] border border-rose-300 bg-rose-50 px-4 py-4">
                <Label
                  className="text-xs font-semibold uppercase tracking-[0.18em] text-rose-700"
                  htmlFor="enable-live-confirmation"
                >
                  Typed Confirmation Required
                </Label>
                <p className="mt-2 text-sm leading-6 text-rose-900">
                  You are saving settings with <span className="font-semibold">dry_run=false</span>{" "}
                  and <span className="font-semibold">allow_live_execution=true</span>.
                  Type <span className="font-semibold">ENABLE LIVE</span> exactly
                  to unlock save.
                </p>
                <Input
                  className="mt-3"
                  id="enable-live-confirmation"
                  onChange={(event) => setEnableLiveConfirmation(event.target.value)}
                  placeholder="ENABLE LIVE"
                  value={enableLiveConfirmation}
                  variant={!liveConfirmationValid ? "error" : "default"}
                />
              </div>
            ) : null}

            {formErrors.length > 0 ? (
              <Alert className="mt-4 border-rose-300 bg-rose-50 text-rose-900">
                <ShieldAlert className="size-4" />
                <AlertTitle>Save is blocked</AlertTitle>
                <AlertDescription>
                  {formErrors.map((error) => (
                    <p key={error}>{error}</p>
                  ))}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6 sm:px-8">
          {settingsLoading && !settings ? (
            <div className="flex min-h-[320px] items-center justify-center">
              <div className="flex items-center gap-3 text-sm text-slate-600">
                <Loader2 className="size-4 animate-spin" />
                Loading backend guardrails...
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {settingsUnavailable ? (
                <Alert className="border-amber-300 bg-amber-50 text-amber-900">
                  <AlertTriangle className="size-4" />
                  <AlertTitle>Showing draft defaults only</AlertTitle>
                  <AlertDescription>
                    Backend settings could not be loaded, so the editor is
                    showing safe defaults. Saving is disabled until the backend
                    settings reload successfully.
                  </AlertDescription>
                </Alert>
              ) : null}
              {BULLPEN_AI_AUTO_LIVE_GUARDRAIL_SECTIONS.map((section) => {
                const sectionFields = BULLPEN_AI_AUTO_LIVE_GUARDRAIL_FIELDS.filter(
                  (field) => field.sectionIds.includes(section.id),
                );

                return (
                  <section
                    className="rounded-[28px] border border-slate-200 bg-slate-50/60 px-4 py-4 sm:px-5"
                    id={`risk-guardrails-${section.id}`}
                    key={section.id}
                  >
                    <div className="mb-4">
                      <h3 className="text-base font-semibold tracking-[0.12em] text-slate-950">
                        {section.title}
                      </h3>
                      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                        {section.description}
                      </p>
                    </div>
                    <div className="grid gap-4 xl:grid-cols-2">
                      {sectionFields.map((field) => {
                        const fieldError = validation.fieldErrors[field.key];
                        const currentValue = currentSettings[field.key];
                        const safeDefault =
                          BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS[field.key];
                        const isChanged = fieldValuesChanged.has(field.key);

                        return (
                          <div
                            className={cn(
                              "rounded-[24px] border bg-white px-4 py-4 shadow-sm",
                              field.key === "emergency_stop"
                                ? "border-rose-300 bg-rose-50/40"
                                : "border-slate-200",
                              fieldError ? "border-rose-300" : null,
                            )}
                            key={`${section.id}-${field.key}`}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="max-w-2xl">
                                <Label className="text-sm font-semibold text-slate-950">
                                  {field.label}
                                </Label>
                                <p className="mt-2 text-sm leading-6 text-slate-600">
                                  {field.description}
                                </p>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600">
                                  {field.tag}
                                </span>
                                <span
                                  className={cn(
                                    "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]",
                                    field.canEnableLiveExecutionRisk
                                      ? "border-rose-200 bg-rose-50 text-rose-700"
                                      : "border-slate-200 bg-white text-slate-500",
                                  )}
                                >
                                  {field.canEnableLiveExecutionRisk
                                    ? "Can enable live execution risk"
                                    : "Does not enable live risk alone"}
                                </span>
                                {isChanged ? (
                                  <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-sky-700">
                                    Unsaved change
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            <div className="mt-4">
                              {field.kind === "boolean" ? (
                                <label
                                  className={cn(
                                    "flex items-center justify-between gap-3 rounded-2xl border px-3 py-3",
                                    fieldError
                                      ? "border-rose-300 bg-rose-50/60"
                                      : "border-slate-200 bg-slate-50/80",
                                  )}
                                >
                                  <div>
                                    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                                      Editable Input
                                    </div>
                                    <div className="mt-1 text-sm font-semibold text-slate-950">
                                      {draft[field.key] ? "Enabled" : "Disabled"}
                                    </div>
                                  </div>
                                  <input
                                    checked={Boolean(draft[field.key])}
                                    className="size-4 accent-slate-950"
                                    onChange={(event) =>
                                      updateDraftValue(field.key, event.target.checked)
                                    }
                                    type="checkbox"
                                  />
                                </label>
                              ) : field.kind === "enum" ? (
                                <div>
                                  <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                                    Editable Input
                                  </div>
                                  <Select
                                    onValueChange={(value) =>
                                      updateDraftValue(field.key, value)
                                    }
                                    value={String(draft[field.key])}
                                  >
                                    <SelectTrigger
                                      className={cn(
                                        "mt-2 w-full rounded-2xl border px-3",
                                        fieldError
                                          ? "border-rose-300 bg-rose-50/60"
                                          : "border-slate-200 bg-slate-50/80",
                                      )}
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {field.options?.map((option) => (
                                        <SelectItem
                                          key={option.value}
                                          value={option.value}
                                        >
                                          {option.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              ) : (
                                <div>
                                  <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                                    Editable Input
                                  </div>
                                  <Input
                                    className="mt-2 rounded-2xl border border-slate-200 bg-slate-50/80 px-3"
                                    inputMode="decimal"
                                    onChange={(event) =>
                                      updateDraftValue(field.key, event.target.value)
                                    }
                                    step={field.step}
                                    value={String(draft[field.key])}
                                    variant={fieldError ? "error" : "default"}
                                  />
                                </div>
                              )}

                              {fieldError ? (
                                <p className="mt-2 text-sm text-rose-700">
                                  {fieldError}
                                </p>
                              ) : (
                                <p className="mt-2 text-xs text-slate-500">
                                  Validation range: {field.rangeLabel}
                                </p>
                              )}
                            </div>

                            <div className="mt-4 grid gap-3 sm:grid-cols-3">
                              <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-3">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                  Current Value
                                </p>
                                <p className="mt-2 text-sm font-semibold text-slate-950">
                                  {formatBullpenAiAutoLiveGuardrailValue(
                                    field.key,
                                    currentValue,
                                  )}
                                </p>
                              </div>
                              <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-3">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                  Safe Default
                                </p>
                                <p className="mt-2 text-sm font-semibold text-slate-950">
                                  {formatBullpenAiAutoLiveGuardrailValue(
                                    field.key,
                                    safeDefault,
                                  )}
                                </p>
                              </div>
                              <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-3">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                  Validation Range
                                </p>
                                <p className="mt-2 text-sm font-semibold text-slate-950">
                                  {field.rangeLabel}
                                </p>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <div className="sticky bottom-0 border-t border-slate-200 bg-white/95 px-6 py-4 backdrop-blur sm:px-8">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="text-sm text-slate-500">
              {lastImportedFileName ? `Imported: ${lastImportedFileName}` : "All edits are local until you save."}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="rounded-full border-slate-300 px-4"
                onClick={handleCancel}
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                className="rounded-full border-slate-300 px-4"
                onClick={handleResetSafeDefaults}
                disabled={resettingBackend}
                variant="outline"
              >
                Reset Safe Defaults
              </Button>
              <Button
                className="rounded-full border-slate-300 px-4"
                disabled={resettingBackend || saving}
                onClick={handleResetBackendDefaults}
                variant="outline"
              >
                {resettingBackend ? <Loader2 className="size-4 animate-spin" /> : null}
                Reset Backend Defaults
              </Button>
              <Button
                className="rounded-full border-slate-300 px-4"
                onClick={handleExportJson}
                variant="outline"
              >
                <Download className="size-4" />
                Export JSON
              </Button>
              <Button
                className="rounded-full border-slate-300 px-4"
                onClick={() => fileInputRef.current?.click()}
                variant="outline"
              >
                <Upload className="size-4" />
                Import JSON
              </Button>
              <Button
                className="rounded-full border-slate-300 px-4"
                onClick={onClose}
                variant="outline"
              >
                Close
              </Button>
              <Button
                className="rounded-full bg-slate-950 px-5 text-white hover:bg-slate-800"
                disabled={
                  resettingBackend ||
                  saving ||
                  settingsLoading ||
                  settingsUnavailable ||
                  hasBlockingValidation ||
                  !liveConfirmationValid
                }
                onClick={handleSave}
              >
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                Save Settings
              </Button>
            </div>
          </div>
        </div>

        <input
          accept="application/json,.json"
          className="hidden"
          onChange={handleImportFile}
          ref={fileInputRef}
          type="file"
        />
      </aside>

      {toast ? (
        <div className="pointer-events-none fixed bottom-6 right-6 z-[80] max-w-sm">
          <div
            className={cn(
              "rounded-2xl border px-4 py-3 shadow-xl",
              toast.kind === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border-rose-200 bg-rose-50 text-rose-900",
            )}
          >
            <p className="text-sm font-semibold">
              {toast.kind === "success" ? "Success" : "Error"}
            </p>
            <p className="mt-1 text-sm leading-6">{toast.message}</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
