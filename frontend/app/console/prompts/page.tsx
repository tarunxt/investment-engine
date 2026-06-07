'use client';

import { useEffect, useState } from 'react';
import {
  BookOpen,
  Check,
  Copy,
  FilePlus,
  Loader2,
  Pencil,
  Plus,
  Shield,
  Trash2,
  User,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiService, APIError } from '@/services/api';
import { PromptResponse, PromptCreate, PromptUpdate } from '@/types/api';
import { getPromptLogicalId } from '@/lib/promptIds';
import { cn } from '@/lib/utils';
import { useClipboard } from '@/hooks/useClipboard';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function normalizeError(err: unknown) {
  if (err instanceof APIError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

type FormState = {
  name: string;
  description: string;
  body: string;
};

const EMPTY_FORM: FormState = { name: '', description: '', body: '' };

const PROMPT_DETAIL_SECTION_NAMES = [
  'TASK',
  'ROLE',
  'OBJECTIVE',
  'MARKET + TIME HORIZON',
  'INPUTS',
  'DATA + SOURCE RULES',
  'COVERAGE RULES',
  'ANALYSIS RULES',
  'DECISION RULES',
  'CAPITAL / UNIT RULES',
  'OUTPUT FORMAT',
  'FALLBACK RULES',
  'VALIDATION CHECKLIST',
  'FINAL OUTPUT RESTRICTION',
] as const;

type PromptDetailSectionName = (typeof PROMPT_DETAIL_SECTION_NAMES)[number];
type PromptDetailSections = Record<PromptDetailSectionName, string>;

function createEmptyPromptSections(): PromptDetailSections {
  return PROMPT_DETAIL_SECTION_NAMES.reduce((acc, section) => {
    acc[section] = '';
    return acc;
  }, {} as PromptDetailSections);
}

function parsePromptSections(body: string): PromptDetailSections {
  const sections = createEmptyPromptSections();
  const sectionPattern = /^\[([^\]]+)\]\s*$/gm;
  const matches = Array.from(body.matchAll(sectionPattern));
  matches.forEach((match, index) => {
    const sectionName = match[1].trim().toUpperCase() as PromptDetailSectionName;
    if (!PROMPT_DETAIL_SECTION_NAMES.includes(sectionName)) return;
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? body.length : body.length;
    sections[sectionName] = body.slice(start, end).trim();
  });
  return sections;
}

function buildPromptBodyFromSections(sections: PromptDetailSections) {
  return PROMPT_DETAIL_SECTION_NAMES
    .map((section) => `[${section}]\n${sections[section].trim()}`)
    .join('\n\n')
    .trim();
}

type PromptMarket = 'India' | 'US' | 'TBD';
type PromptStageId =
  | 'portfolio-scan'
  | 'event-scan'
  | 'threat-scan'
  | 'swing-opportunities'
  | 'rebalance'
  | 'technical-scan'
  | 'uncategorized';

type PromptStage = {
  id: PromptStageId;
  label: string;
  description: string;
  showMarketTags: boolean;
};

const PROMPT_STAGES: PromptStage[] = [
  { id: 'portfolio-scan', label: 'Stage 1 · Portfolio Scan', description: 'Portfolio snapshot, sync, and holdings-context prompts.', showMarketTags: false },
  { id: 'event-scan', label: 'Stage 1B · Events Scan', description: 'Portfolio Event Calendar Scan Flow only.', showMarketTags: true },
  { id: 'threat-scan', label: 'Stage 2 · Threats Scan', description: 'INDmoney US Threat Scan Flow and Zerodha Threat Scan Flow.', showMarketTags: true },
  { id: 'swing-opportunities', label: 'Stage 3 · Swing Opportunities Scan', description: 'India Swing-Trade Research and US Swing-Trade Research.', showMarketTags: false },
  { id: 'rebalance', label: 'Stage 4 · Rebalance Suggestions', description: 'India Portfolio Rebalance Flow and US Portfolio Rebalance Flow.', showMarketTags: false },
  { id: 'technical-scan', label: 'Stage 5 · Technical Scan', description: 'Technical Setup Scan Flow.', showMarketTags: true },
  { id: 'uncategorized', label: 'Uncategorized', description: 'Prompts that need manual stage tagging.', showMarketTags: false },
];

const PROMPT_NAME_STAGE_MAP: Array<[RegExp, PromptStageId]> = [
  [/^portfolio event calendar scan flow$/i, 'event-scan'],
  [/^(?:indmoney us|zerodha) threat scan flow$/i, 'threat-scan'],
  [/^(?:india|us) swing-trade research$/i, 'swing-opportunities'],
  [/^(?:india|us) portfolio rebalance flow$/i, 'rebalance'],
  [/^technical setup scan flow$/i, 'technical-scan'],
];

function inferPromptStageId(prompt: PromptResponse): PromptStageId {
  const mapped = PROMPT_NAME_STAGE_MAP.find(([pattern]) => pattern.test(prompt.name.trim()));
  if (mapped) return mapped[1];

  const haystack = `${prompt.name} ${prompt.description ?? ''} ${prompt.body}`.toLowerCase();
  if (/portfolio event calendar|event|calendar|catalyst|earnings/.test(haystack)) return 'event-scan';
  if (/threat|risk|guardrail|downside/.test(haystack)) return 'threat-scan';
  if (/swing|opportunit|momentum|setup/.test(haystack)) return 'swing-opportunities';
  if (/rebalance|allocation|weight|trim|hold|target/.test(haystack)) return 'rebalance';
  if (/technical|chart|entry|exit|validation/.test(haystack)) return 'technical-scan';
  if (/portfolio|holding|snapshot|sync|zerodha|indmoney/.test(haystack)) return 'portfolio-scan';
  return 'uncategorized';
}

type PromptMetadata = {
  stage: PromptStage;
  markets: PromptMarket[];
};

function inferPromptMetadata(prompt: PromptResponse): PromptMetadata {
  const stageId = inferPromptStageId(prompt);
  const stage = PROMPT_STAGES.find((item) => item.id === stageId) ?? PROMPT_STAGES[PROMPT_STAGES.length - 1];
  if (!stage.showMarketTags) return { stage, markets: [] };

  if (stage.id === 'event-scan' || stage.id === 'threat-scan' || stage.id === 'technical-scan') {
    return { stage, markets: ['India', 'US'] };
  }

  return { stage, markets: ['TBD'] };
}

export default function PromptsPage() {
  const { copy } = useClipboard();
  const [prompts, setPrompts] = useState<PromptResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // modal state
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<PromptResponse | null>(null);
  const [isFork, setIsFork] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [promptSections, setPromptSections] = useState<PromptDetailSections>(() => createEmptyPromptSections());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // copy feedback
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<PromptResponse | null>(null);
  const [deleting, setDeleting] = useState(false);

  const systemPrompts = prompts.filter((p) => p.is_system);
  const myPrompts = prompts.filter((p) => !p.is_system);

  async function loadPrompts() {
    setLoading(true);
    try {
      const data = await apiService.getPrompts();
      setPrompts(data);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPrompts();
  }, []);

  function openCreate() {
    setEditTarget(null);
    setIsFork(false);
    setForm(EMPTY_FORM);
    setPromptSections(createEmptyPromptSections());
    setFormError(null);
    setShowModal(true);
  }

  function openEdit(prompt: PromptResponse) {
    setEditTarget(prompt);
    setIsFork(false);
    setForm({ name: prompt.name, description: prompt.description ?? '', body: prompt.body });
    setPromptSections(parsePromptSections(prompt.body));
    setFormError(null);
    setShowModal(true);
  }

  function openFork(prompt: PromptResponse) {
    setEditTarget(null);
    setIsFork(true);
    setForm({ name: prompt.name, description: prompt.description ?? '', body: prompt.body });
    setPromptSections(parsePromptSections(prompt.body));
    setFormError(null);
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditTarget(null);
    setIsFork(false);
    setForm(EMPTY_FORM);
    setPromptSections(createEmptyPromptSections());
    setFormError(null);
  }

  function updatePromptSection(section: PromptDetailSectionName, value: string) {
    setPromptSections((current) => {
      const next = { ...current, [section]: value };
      setForm((existing) => ({ ...existing, body: buildPromptBodyFromSections(next) }));
      return next;
    });
  }

  async function handleSave() {
    const promptName = form.name.trim() || 'Untitled Prompt';
    if (!form.body.trim()) {
      setFormError('Prompt detail sections are required.');
      return;
    }

    setSaving(true);
    setFormError(null);

    try {
      if (editTarget) {
        const update: PromptUpdate = {
          name: promptName,
          description: form.description.trim() || undefined,
          body: form.body,
        };
        const updated = await apiService.updatePrompt(editTarget.id, update);
        setPrompts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      } else {
        const create: PromptCreate = {
          name: promptName,
          description: form.description.trim() || undefined,
          body: form.body,
        };
        const created = await apiService.createPrompt(create);
        setPrompts((prev) => [...prev, created]);
      }
      closeModal();
    } catch (err) {
      setFormError(normalizeError(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiService.deletePrompt(deleteTarget.id);
      setPrompts((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setDeleting(false);
    }
  }

  async function copyBody(prompt: PromptResponse) {
    const success = await copy(prompt.body);
    if (success) {
      setCopiedId(prompt.id);
      setTimeout(() => setCopiedId(null), 2000);
    } else {
      // Handle error (show toast notification)
      console.error('Failed to copy prompt');
    }
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950">Prompt Library</h1>
          <p className="mt-1 text-sm text-gray-600">
            Prompts are grouped by workflow stage and tagged separately for India and US coverage. System prompts are shared across all users; My Prompts are private to your account.
          </p>
        </div>
        <Button onClick={openCreate} className="w-full sm:w-auto">
          <Plus className="mr-2 size-4" />
          New Prompt
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <X className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <Tabs defaultValue="system">
        <TabsList className="border border-gray-200 bg-gray-50">
          <TabsTrigger value="system" className="gap-2">
            <Shield className="size-3.5" />
            System Prompts
            {systemPrompts.length > 0 && (
              <span className="ml-1 rounded-full bg-indigo-100 px-1.5 py-0.5 text-xs font-medium text-indigo-700">
                {systemPrompts.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="mine" className="gap-2">
            <User className="size-3.5" />
            My Prompts
            {myPrompts.length > 0 && (
              <span className="ml-1 rounded-full bg-gray-200 px-1.5 py-0.5 text-xs font-medium text-gray-700">
                {myPrompts.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="system" className="mt-4">
          <PromptGrid
            prompts={systemPrompts}
            loading={loading}
            emptyMessage="No system prompts configured."
            copiedId={copiedId}
            onCopy={copyBody}
            onFork={openFork}
            onEdit={openEdit}
            onDelete={null}
          />
        </TabsContent>

        <TabsContent value="mine" className="mt-4">
          <PromptGrid
            prompts={myPrompts}
            loading={loading}
            emptyMessage="No prompts yet. Click 'New Prompt' to create one."
            copiedId={copiedId}
            onCopy={copyBody}
            onFork={null}
            onEdit={openEdit}
            onDelete={setDeleteTarget}
          />
        </TabsContent>
      </Tabs>

      {/* Create / Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-950">
                {editTarget ? 'Prompt Details' : isFork ? 'Save as My Prompt' : 'New Prompt'}
              </h2>
              <button onClick={closeModal} className="text-gray-400 hover:text-gray-600">
                <X className="size-5" />
              </button>
            </div>

            <div className="space-y-4 px-6 py-5">
              {formError && (
                <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {formError}
                </div>
              )}

              <details className="border border-gray-200 bg-gray-50">
                <summary className="cursor-pointer px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-700">
                  [Full Prompt]
                </summary>
                <textarea
                  value={form.body}
                  readOnly
                  rows={10}
                  className="w-full resize-y border-t border-gray-200 bg-white px-3 py-2 font-mono text-xs text-gray-800 outline-none"
                  aria-label="Full Prompt"
                />
              </details>

              <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
                {PROMPT_DETAIL_SECTION_NAMES.map((section) => (
                  <div key={section} className="space-y-1.5">
                    <Label htmlFor={`prompt-section-${section}`}>[{section}]</Label>
                    <textarea
                      id={`prompt-section-${section}`}
                      value={promptSections[section]}
                      onChange={(e) => updatePromptSection(section, e.target.value)}
                      rows={section === 'OUTPUT FORMAT' ? 8 : 4}
                      className="w-full resize-y border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-950 shadow-sm outline-none transition focus:border-gray-950 focus:ring-2 focus:ring-gray-950/10"
                      placeholder={`Define ${section.toLowerCase()}`}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-4">
              <Button variant="outline" onClick={closeModal} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                {editTarget ? 'Save Changes' : isFork ? 'Save as Mine' : 'Create Prompt'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm bg-white shadow-xl">
            <div className="px-6 py-5">
              <h2 className="text-sm font-semibold text-gray-950">Delete Prompt</h2>
              <p className="mt-2 text-sm text-gray-600">
                Are you sure you want to delete{' '}
                <span className="font-medium text-gray-950">&quot;{deleteTarget.name}&quot;</span>? This
                cannot be undone.
              </p>
            </div>
            <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-4">
              <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                Cancel
              </Button>
              <Button
                variant="outline"
                className="border-red-200 text-red-700 hover:bg-red-50"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Trash2 className="mr-2 size-4" />}
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type PromptGridProps = {
  prompts: PromptResponse[];
  loading: boolean;
  emptyMessage: string;
  copiedId: number | null;
  onCopy: (p: PromptResponse) => void;
  onFork: ((p: PromptResponse) => void) | null;
  onEdit: ((p: PromptResponse) => void) | null;
  onDelete: ((p: PromptResponse) => void) | null;
};

function PromptGrid({ prompts, loading, emptyMessage, copiedId, onCopy, onFork, onEdit, onDelete }: PromptGridProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-gray-500">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading prompts…
      </div>
    );
  }

  if (prompts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-sm text-gray-500">
        <BookOpen className="size-8 text-gray-300" />
        <span>{emptyMessage}</span>
      </div>
    );
  }

  const promptsByStage = PROMPT_STAGES.map((stage) => ({
    stage,
    prompts: prompts
      .map((prompt) => ({ prompt, metadata: inferPromptMetadata(prompt) }))
      .filter((item) => item.metadata.stage.id === stage.id),
  })).filter((section) => section.prompts.length > 0);

  return (
    <div className="flex flex-col gap-6">
      {promptsByStage.map(({ stage, prompts: stagePrompts }) => (
        <section key={stage.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-gray-950">{stage.label}</h2>
              <p className="mt-1 text-xs text-gray-500">{stage.description}</p>
            </div>
            <span className="w-fit rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-600">
              {stagePrompts.length} prompt{stagePrompts.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {stagePrompts.map(({ prompt, metadata }) => (
              <PromptCard
                key={prompt.id}
                prompt={prompt}
                metadata={metadata}
                copiedId={copiedId}
                onCopy={onCopy}
                onFork={onFork}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

type PromptCardProps = {
  prompt: PromptResponse;
  metadata: PromptMetadata;
  copiedId: number | null;
  onCopy: (p: PromptResponse) => void;
  onFork: ((p: PromptResponse) => void) | null;
  onEdit: ((p: PromptResponse) => void) | null;
  onDelete: ((p: PromptResponse) => void) | null;
};

function PromptCard({ prompt, metadata, copiedId, onCopy, onFork, onEdit, onDelete }: PromptCardProps) {
  const isCopied = copiedId === prompt.id;

  return (
    <Card className="flex flex-col border border-gray-200 shadow-sm transition hover:border-gray-300 hover:shadow-md">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-semibold leading-snug text-gray-950">
            {prompt.name}
          </CardTitle>
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
              prompt.is_system
                ? 'bg-indigo-50 text-indigo-700'
                : 'bg-gray-100 text-gray-600',
            )}
          >
            v{prompt.version}
          </span>
        </div>
        {metadata.markets.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {metadata.markets.map((market) => (
              <span
                key={market}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                  market === 'India'
                    ? 'bg-emerald-50 text-emerald-700'
                    : market === 'US'
                      ? 'bg-blue-50 text-blue-700'
                      : 'bg-amber-50 text-amber-700',
                )}
              >
                {market === 'TBD' ? 'Market TBD' : market}
              </span>
            ))}
          </div>
        )}
        {prompt.description && (
          <p className="mt-1 text-xs text-gray-500 leading-relaxed">{prompt.description}</p>
        )}
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        {/* Body preview */}
        <button
          type="button"
          onClick={() => onEdit?.(prompt)}
          className="line-clamp-4 flex-1 text-left text-xs leading-5 text-gray-600 transition hover:text-gray-950 focus:outline-none focus:ring-2 focus:ring-gray-950/10"
          title="Open expanded prompt"
        >
          {prompt.body}
        </button>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-gray-400">Updated {formatDate(prompt.updated_at)} · Prompt ID <span className="font-mono text-gray-500">{getPromptLogicalId(prompt.name, prompt.id)}</span></span>

          <div className="flex items-center gap-1">
            <Button
              variant={'outline'}
              onClick={() => onCopy(prompt)}
              title="Copy prompt body"
              className="h-8 w-8 rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            >
              {isCopied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
            </Button>
            {onFork && (
              <Button
                variant={'outline'}
                onClick={() => onFork(prompt)}
                title="Save as my prompt"
                className="h-8 w-8 rounded p-1.5 text-gray-400 hover:bg-indigo-50 hover:text-indigo-600"
              >
                <FilePlus className="size-3.5" />
              </Button>
            )}
            {onEdit && (
              <Button
                variant={'outline'}
                onClick={() => onEdit(prompt)}
                title="Edit prompt"
                className="h-8 w-8 rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              >
                <Pencil className="size-3.5" />
              </Button>
            )}
            {onDelete && (
              <Button
                onClick={() => onDelete(prompt)}
                title="Delete prompt"
                variant={'outline'}
                className="h-8 w-8 rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
