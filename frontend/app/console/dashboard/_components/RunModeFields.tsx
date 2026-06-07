"use client";

import { LlmModelSelectionPanel } from "@/components/shared/LlmModelSelectionPanel";
import { useDashboard } from "../_context";

export function RunModeFields() {
  const {
    isLoading,
    providers,
    selectedTargets,
    toggleTarget,
    toggleAllForProvider,
    selectAllTargets,
    unselectAllTargets,
    savedModelMixes,
    selectedModelMixId,
    applyModelMix,
    saveModelMix,
    renameModelMix,
    deleteModelMix,
  } = useDashboard();

  const selectedCount = selectedTargets.size;

  return (
    <div className="space-y-3">
      <LlmModelSelectionPanel
        providers={providers}
        selectedKeys={selectedTargets}
        loading={isLoading}
        modelMixControls={
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center">
            <select
              value={selectedModelMixId || "none"}
              onChange={(e) => applyModelMix(e.target.value)}
              className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm text-slate-700 shadow-sm"
            >
              <option value="none">Model mix templates</option>
              {savedModelMixes.map((mix) => (
                <option key={mix.id} value={mix.id}>
                  {mix.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
              onClick={() => {
                const name = window.prompt("Name this model mix:");
                if (!name) return;
                const id = saveModelMix(name);
                if (!id)
                  window.alert(
                    "Select at least one model before saving a mix.",
                  );
              }}
            >
              Name and Save Model Mix
            </button>
            <button
              type="button"
              disabled={
                !selectedModelMixId ||
                selectedModelMixId === "compatible-models-system"
              }
              className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
              onClick={() => {
                if (!selectedModelMixId) return;
                if (selectedModelMixId === "compatible-models-system") return;
                const current = savedModelMixes.find(
                  (mix) => mix.id === selectedModelMixId,
                );
                const name = window.prompt(
                  "Edit model mix name:",
                  current?.name || "",
                );
                if (!name) return;
                renameModelMix(selectedModelMixId, name);
              }}
            >
              Edit
            </button>
            <button
              type="button"
              disabled={
                !selectedModelMixId ||
                selectedModelMixId === "compatible-models-system"
              }
              className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
              onClick={() => {
                if (!selectedModelMixId) return;
                if (selectedModelMixId === "compatible-models-system") return;
                const current = savedModelMixes.find(
                  (mix) => mix.id === selectedModelMixId,
                );
                const ok = window.confirm(
                  `Delete model mix "${current?.name || selectedModelMixId}"?`,
                );
                if (ok) deleteModelMix(selectedModelMixId);
              }}
            >
              Delete
            </button>
          </div>
        }
        onToggle={toggleTarget}
        onSelectAll={selectAllTargets}
        onClear={unselectAllTargets}
        onToggleProvider={toggleAllForProvider}
      />

      {selectedCount === 0 && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm">
          <div className="h-4 w-4 rounded-full bg-red-400 text-center text-[10px] font-bold text-white">
            !
          </div>
          <p className="text-red-700">Select at least one model to continue</p>
        </div>
      )}
    </div>
  );
}
