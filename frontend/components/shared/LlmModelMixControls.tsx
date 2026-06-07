"use client";

export type LlmModelMixOption = {
  id: string;
  name: string;
};

interface LlmModelMixControlsProps {
  mixes: LlmModelMixOption[];
  selectedMixId?: string;
  onApply: (id: string) => void;
  onSave: () => void;
  onEdit: () => void;
  onDelete: () => void;
  systemMixId?: string;
}

export function LlmModelMixControls({
  mixes,
  selectedMixId,
  onApply,
  onSave,
  onEdit,
  onDelete,
  systemMixId = "compatible-models-system",
}: LlmModelMixControlsProps) {
  const canEditSavedMix = Boolean(
    selectedMixId && selectedMixId !== "none" && selectedMixId !== systemMixId,
  );

  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center">
      <select
        value={selectedMixId || "none"}
        onChange={(e) => onApply(e.target.value)}
        className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm text-slate-700 shadow-sm"
      >
        <option value="none">Model mix templates</option>
        {mixes.map((mix) => (
          <option key={mix.id} value={mix.id}>
            {mix.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
        onClick={onSave}
      >
        Name and Save Model Mix
      </button>
      <button
        type="button"
        disabled={!canEditSavedMix}
        className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
        onClick={onEdit}
      >
        Edit
      </button>
      <button
        type="button"
        disabled={!canEditSavedMix}
        className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
        onClick={onDelete}
      >
        Delete
      </button>
    </div>
  );
}
