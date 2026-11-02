"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { loadScoreMatrixFormulaConfig, saveScoreMatrixFormulaConfig, type ScoreMatrixFormulaConfig } from "@/app/console/_components/FinalActionablesConsole";
import { DEFAULT_ZERODHA_BUY_THRESHOLD } from "@/lib/zerodhaBasketSelection";
import { shouldSaveThresholds, thresholdSignature, type ThresholdPersistence } from "@/lib/buyThresholdPersistence";
import { normalizeError } from "@/app/console/dashboard/_components/dashboardOverviewUtils";
import { apiService } from "@/services/api";

function useConfigurationOwner() {
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

  useEffect(() => {
    saveScoreMatrixFormulaConfig(scoreMatrixFormulaConfig);
  }, [scoreMatrixFormulaConfig]);

  useEffect(() => {
    let cancelled = false;
    void apiService.getProfile()
      .then((profile) => {
        if (cancelled) return;
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
        if (!cancelled) {
          setBuyThresholdSaveError(`Could not load saved Buy Threshold: ${normalizeError(error)}`);
          setBuyThresholdPersistence("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const signature = thresholdSignature(zerodhaBasketBuyThreshold, indmoneyBasketBuyThreshold);
    if (!shouldSaveThresholds(buyThresholdPreferencesLoaded, buyThresholdPreferencesWritable, savedBuyThresholdSignature.current, signature, pendingBuyThresholdSaves.current > 0)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setBuyThresholdSaveError(null);
      setBuyThresholdPersistence("saving");
      pendingBuyThresholdSaves.current += 1;
      const save = buyThresholdSaveQueue.current.then(async () => {
        if (!active) return false;
        await apiService.updateProfile({
        zerodha_buy_threshold: zerodhaBasketBuyThreshold,
        indmoney_buy_threshold: indmoneyBasketBuyThreshold,
        });
        return true;
      });
      buyThresholdSaveQueue.current = save.then(() => undefined, () => undefined);
      void save.then((written) => {
        if (written) savedBuyThresholdSignature.current = signature;
        if (!active) return;
        setBuyThresholdPersistence("saved");
      }).catch((error) => {
        if (!active) return;
        setBuyThresholdSaveError(`Could not save Buy Threshold: ${normalizeError(error)}`);
        setBuyThresholdPersistence("error");
        if (/analysis-only recovery/i.test(normalizeError(error))) setBuyThresholdPreferencesWritable(false);
      }).finally(() => { pendingBuyThresholdSaves.current -= 1; });
    }, 400);
    return () => { active = false; window.clearTimeout(timer); };
  }, [
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
