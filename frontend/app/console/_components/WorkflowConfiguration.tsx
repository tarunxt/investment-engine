"use client";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { loadScoreMatrixFormulaConfig, saveScoreMatrixFormulaConfig, type ScoreMatrixFormulaConfig } from "@/app/console/_components/FinalActionablesConsole";
import { DEFAULT_ZERODHA_BUY_THRESHOLD } from "@/lib/zerodhaBasketSelection";
import { shouldSaveThresholds, thresholdSignature, type ThresholdPersistence } from "@/lib/buyThresholdPersistence";
import { normalizeError } from "@/app/console/dashboard/_components/dashboardOverviewUtils";
import { apiService as unownedApiService } from "@/services/api";
import { captureWorkflowOwner, isCurrentWorkflowOwner } from "@/lib/workflowOwnerLifetime";
import { workflowOwnedApi } from "@/lib/workflowOwnedApi";

function useConfigurationOwner() {
  const [runtimeOwner] = useState(captureWorkflowOwner);
  const apiService = useMemo(() => workflowOwnedApi(unownedApiService, runtimeOwner), [runtimeOwner]);
  const [scoreMatrixFormulaConfig, setScoreMatrixFormulaConfig] = useState<ScoreMatrixFormulaConfig>(() => loadScoreMatrixFormulaConfig());
  const [zerodhaBasketBuyThreshold, setZerodhaBasketBuyThreshold] = useState(DEFAULT_ZERODHA_BUY_THRESHOLD);
  const [zerodhaBasketBuyThresholdDraft, setZerodhaBasketBuyThresholdDraft] = useState(
    DEFAULT_ZERODHA_BUY_THRESHOLD.toFixed(2),
  );
  const [buyThresholdPreferencesLoaded, setBuyThresholdPreferencesLoaded] = useState(false);
  const [buyThresholdPreferencesWritable, setBuyThresholdPreferencesWritable] = useState(false);
  const [buyThresholdPersistence, setBuyThresholdPersistence] = useState<ThresholdPersistence>("loading");
  const savedBuyThresholdSignature = useRef<string | null>(null);
  const buyThresholdSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingBuyThresholdSaves = useRef(0);
  const [buyThresholdSaveError, setBuyThresholdSaveError] = useState<string | null>(null);
  const [indmoneyBasketBuyThreshold, setIndmoneyBasketBuyThreshold] = useState(2.5);
  const [indmoneyBasketBuyThresholdDraft, setIndmoneyBasketBuyThresholdDraft] = useState("2.50");

  const savedFormulaSignature = useRef(JSON.stringify(scoreMatrixFormulaConfig));
  useEffect(() => {
    if (!isCurrentWorkflowOwner(runtimeOwner)) return;
    const signature = JSON.stringify(scoreMatrixFormulaConfig);
    if (signature === savedFormulaSignature.current) return;
    saveScoreMatrixFormulaConfig(scoreMatrixFormulaConfig);
    savedFormulaSignature.current = signature;
  }, [runtimeOwner, scoreMatrixFormulaConfig]);

  useEffect(() => {
    if (!isCurrentWorkflowOwner(runtimeOwner)) return;
    let cancelled = false;
    void apiService.getProfile()
      .then((profile) => {
        if (cancelled || !isCurrentWorkflowOwner(runtimeOwner)) return;
        const zerodhaThreshold = Number(profile.zerodha_buy_threshold);
        const indmoneyThreshold = Number(profile.indmoney_buy_threshold);
        if (Number.isFinite(zerodhaThreshold)) {
          setZerodhaBasketBuyThreshold(zerodhaThreshold);
          setZerodhaBasketBuyThresholdDraft(zerodhaThreshold.toFixed(2));
        }
        if (Number.isFinite(indmoneyThreshold)) {
          setIndmoneyBasketBuyThreshold(indmoneyThreshold);
          setIndmoneyBasketBuyThresholdDraft(indmoneyThreshold.toFixed(2));
        }
        savedBuyThresholdSignature.current = thresholdSignature(
          Number.isFinite(zerodhaThreshold) ? zerodhaThreshold : DEFAULT_ZERODHA_BUY_THRESHOLD,
          Number.isFinite(indmoneyThreshold) ? indmoneyThreshold : 2.5,
        );
        const writable = profile.preferences_writable === true;
        setBuyThresholdPreferencesWritable(writable);
        setBuyThresholdPersistence(writable ? "saved" : profile.preferences_writable === false ? "local_only" : "unconfirmed");
        setBuyThresholdPreferencesLoaded(true);
      })
      .catch((error) => {
        if (!cancelled && isCurrentWorkflowOwner(runtimeOwner)) {
          setBuyThresholdSaveError(`Could not load saved Buy Threshold: ${normalizeError(error)}`);
          setBuyThresholdPersistence("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiService, runtimeOwner]);

  useEffect(() => {
    if (!isCurrentWorkflowOwner(runtimeOwner)) return;
    const signature = thresholdSignature(zerodhaBasketBuyThreshold, indmoneyBasketBuyThreshold);
    if (!shouldSaveThresholds(buyThresholdPreferencesLoaded, buyThresholdPreferencesWritable, savedBuyThresholdSignature.current, signature, pendingBuyThresholdSaves.current > 0)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      if (!active || !isCurrentWorkflowOwner(runtimeOwner)) return;
      setBuyThresholdSaveError(null);
      setBuyThresholdPersistence("saving");
      pendingBuyThresholdSaves.current += 1;
      const save = buyThresholdSaveQueue.current.then(async () => {
        if (!active || !isCurrentWorkflowOwner(runtimeOwner)) return false;
        await apiService.updateProfile({
        zerodha_buy_threshold: zerodhaBasketBuyThreshold,
        indmoney_buy_threshold: indmoneyBasketBuyThreshold,
        });
        return true;
      });
      buyThresholdSaveQueue.current = save.then(() => undefined, () => undefined);
      void save.then((written) => {
        if (!active || !isCurrentWorkflowOwner(runtimeOwner)) return;
        if (written) savedBuyThresholdSignature.current = signature;
        setBuyThresholdPersistence("saved");
      }).catch((error) => {
        if (!active || !isCurrentWorkflowOwner(runtimeOwner)) return;
        setBuyThresholdSaveError(`Could not save Buy Threshold: ${normalizeError(error)}`);
        setBuyThresholdPersistence("error");
        if (/analysis-only recovery/i.test(normalizeError(error))) setBuyThresholdPreferencesWritable(false);
      }).finally(() => { pendingBuyThresholdSaves.current -= 1; });
    }, 400);
    return () => { active = false; window.clearTimeout(timer); };
  }, [
    apiService,
    runtimeOwner,
    buyThresholdPreferencesLoaded,
    buyThresholdPreferencesWritable,
    indmoneyBasketBuyThreshold,
    zerodhaBasketBuyThreshold,
  ]);

  return { scoreMatrixFormulaConfig, setScoreMatrixFormulaConfig, zerodhaBasketBuyThreshold, setZerodhaBasketBuyThreshold, zerodhaBasketBuyThresholdDraft, setZerodhaBasketBuyThresholdDraft, indmoneyBasketBuyThreshold, setIndmoneyBasketBuyThreshold, indmoneyBasketBuyThresholdDraft, setIndmoneyBasketBuyThresholdDraft, buyThresholdSaveError, buyThresholdPersistence };
}

const ConfigurationContext = createContext<ReturnType<typeof useConfigurationOwner> | null>(null);
export function WorkflowConfigurationProvider({children}: {children: ReactNode}) {
  const value = useConfigurationOwner();
  return <ConfigurationContext.Provider value={value}>{children}</ConfigurationContext.Provider>;
}
export function useWorkflowConfiguration() {
  const value = useContext(ConfigurationContext);
  if (!value) throw new Error("Workflow configuration owner is unavailable");
  return value;
}
