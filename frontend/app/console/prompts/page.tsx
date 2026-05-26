'use client';

import { useEffect, useState } from 'react';
import {
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiService, APIError } from '@/services/api';
import { PromptResponse, PromptCreate, PromptUpdate } from '@/types/api';
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

const PROMPTS_PER_PAGE = 9;

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
    setFormError(null);
    setShowModal(true);
  }

  function openEdit(prompt: PromptResponse) {
    setEditTarget(prompt);
    setIsFork(false);
    setForm({ name: prompt.name, description: prompt.description ?? '', body: prompt.body });
    setFormError(null);
    setShowModal(true);
  }

  function openFork(prompt: PromptResponse) {
    setEditTarget(null);
    setIsFork(true);
    setForm({ name: prompt.name, description: prompt.description ?? '', body: prompt.body });
    setFormError(null);
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditTarget(null);
    setIsFork(false);
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.body.trim()) {
      setFormError('Name and body are required.');
      return;
    }

    setSaving(true);
    setFormError(null);

    try {
      if (editTarget) {
        const update: PromptUpdate = {
          name: form.name.trim(),
          description: form.description.trim() || undefined,
          body: form.body,
        };
        const updated = await apiService.updatePrompt(editTarget.id, update);
        setPrompts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      } else {
        const create: PromptCreate = {
          name: form.name.trim(),
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
            System prompts are shared across all users. My Prompts are private to your account.
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
            onEdit={null}
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
                {editTarget ? 'Edit Prompt' : isFork ? 'Save as My Prompt' : 'New Prompt'}
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

              <div className="space-y-1.5">
                <Label htmlFor="p-name">Name</Label>
                <Input
                  id="p-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="India Swing-Trade Research"
                  className="border-gray-300"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="p-desc">
                  Description <span className="text-gray-400">(optional)</span>
                </Label>
                <Input
                  id="p-desc"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Short description of what this prompt does"
                  className="border-gray-300"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="p-body">Prompt Body</Label>
                <textarea
                  id="p-body"
                  value={form.body}
                  onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                  rows={14}
                  className="w-full resize-y border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-950 shadow-sm outline-none transition focus:border-gray-950 focus:ring-2 focus:ring-gray-950/10"
                  placeholder="Enter your prompt text here..."
                />
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
  const [page, setPage] = useState(1);
  const [prevLength, setPrevLength] = useState(prompts.length);

  // Reset to page 1 whenever the prompts list changes (e.g. after create/delete)
  if (prevLength !== prompts.length) {
    setPrevLength(prompts.length);
    setPage(1);
  }

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

  const totalPages = Math.max(1, Math.ceil(prompts.length / PROMPTS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const slice = prompts.slice((currentPage - 1) * PROMPTS_PER_PAGE, currentPage * PROMPTS_PER_PAGE);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {slice.map((prompt) => (
          <PromptCard
            key={prompt.id}
            prompt={prompt}
            copiedId={copiedId}
            onCopy={onCopy}
            onFork={onFork}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-gray-200 pt-3">
          <span className="text-xs text-gray-500">
            {(currentPage - 1) * PROMPTS_PER_PAGE + 1}–{Math.min(currentPage * PROMPTS_PER_PAGE, prompts.length)} of {prompts.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
              className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="min-w-16 text-center text-xs text-gray-600">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
              className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type PromptCardProps = {
  prompt: PromptResponse;
  copiedId: number | null;
  onCopy: (p: PromptResponse) => void;
  onFork: ((p: PromptResponse) => void) | null;
  onEdit: ((p: PromptResponse) => void) | null;
  onDelete: ((p: PromptResponse) => void) | null;
};

function PromptCard({ prompt, copiedId, onCopy, onFork, onEdit, onDelete }: PromptCardProps) {
  const isCopied = copiedId === prompt.id;

  return (
    <Card className="flex flex-col border border-gray-200 shadow-sm">
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
        {prompt.description && (
          <p className="mt-1 text-xs text-gray-500 leading-relaxed">{prompt.description}</p>
        )}
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        {/* Body preview */}
        <p className="line-clamp-4 flex-1 text-xs leading-5 text-gray-600">{prompt.body}</p>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-gray-400">Updated {formatDate(prompt.updated_at)}</span>

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
