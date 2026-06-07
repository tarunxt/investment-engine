"use client";

import { LlmModelMixControls } from "@/components/shared/LlmModelMixControls";
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
          <LlmModelMixControls
            mixes={savedModelMixes}
            selectedMixId={selectedModelMixId}
            onApply={applyModelMix}
            onSave={() => {
              const name = window.prompt("Name this model mix:");
              if (!name) return;
              const id = saveModelMix(name);
              if (!id)
                window.alert(
                  "Select at least one model before saving a mix.",
                );
            }}
            onEdit={() => {
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
            onDelete={() => {
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
          />
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
