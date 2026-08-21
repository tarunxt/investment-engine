'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Mail,
  RefreshCw,
  Send,
  Wrench,
} from 'lucide-react';

import { URLs } from '@/lib/urls';

const RECIPIENT = 'tarun.singh6893@gmail.com';
const MESSAGE = "Hi, this a message from Tarun's Cred-X";

type MailHistoryItem = {
  id: number;
  created_at: string;
  status: string;
  trigger: string;
  recipients: string[];
  subject: string;
  message: string;
  remarks: string;
  run_id?: string | null;
  warnings: Array<{
    market_id?: string;
    question?: string;
    position_side?: string;
    held_side_llm_odds?: number;
    recommended_action?: string;
  }>;
  provider_code?: string | null;
  provider_summary?: string | null;
  provider_message?: string | null;
};

type MailFailure = {
  code: string;
  summary: string;
  provider_message?: string | null;
  how_to_fix: string[];
  configuration?: {
    host: string;
    port?: number | null;
    username_configured: boolean;
    password_configured: boolean;
    from_email: string;
    from_name: string;
  };
};

function normalizeFailure(payload: unknown): MailFailure {
  const candidate =
    payload && typeof payload === 'object' && 'detail' in payload
      ? (payload as { detail?: unknown }).detail
      : payload;

  if (candidate && typeof candidate === 'object' && 'code' in candidate) {
    const detail = candidate as Partial<MailFailure>;
    return {
      code: detail.code || 'EMAIL_SEND_FAILED',
      summary: detail.summary || 'The email could not be sent.',
      provider_message: detail.provider_message,
      how_to_fix: Array.isArray(detail.how_to_fix) ? detail.how_to_fix : [],
      configuration: detail.configuration,
    };
  }

  return {
    code: 'EMAIL_SEND_FAILED',
    summary:
      typeof candidate === 'string'
        ? candidate
        : 'The email could not be sent.',
    how_to_fix: [
      'Check the investor-backend logs and verify the SMTP configuration.',
    ],
  };
}

export default function MailsPage() {
  const [selected, setSelected] = useState(true);
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [failure, setFailure] = useState<MailFailure | null>(null);
  const [history, setHistory] = useState<MailHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await fetch(URLs.mails.history(), {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const payload = (await response.json().catch(() => null)) as
        | { items?: MailHistoryItem[]; detail?: unknown }
        | null;
      if (!response.ok || !Array.isArray(payload?.items)) {
        throw new Error('Mail history could not be loaded.');
      }
      setHistory(payload.items);
    } catch (historyFailure) {
      setHistoryError(
        historyFailure instanceof Error
          ? historyFailure.message
          : 'Mail history could not be loaded.',
      );
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  async function sendMail() {
    if (!selected || sending) return;

    setSending(true);
    setSuccess(null);
    setFailure(null);

    try {
      const response = await fetch(URLs.mails.sendTest(), {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setFailure(normalizeFailure(payload));
        return;
      }

      setSuccess(`Email sent successfully to ${RECIPIENT}.`);
      await loadHistory();
    } catch (sendError) {
      setFailure({
        code: 'MAIL_API_UNREACHABLE',
        summary:
          sendError instanceof Error
            ? sendError.message
            : 'The mail API could not be reached.',
        how_to_fix: [
          'Reload the page and try once more.',
          'If it continues, verify that investor-backend is running and inspect its logs.',
        ],
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <section className="overflow-hidden rounded-3xl border border-border bg-card shadow-sm">
        <div className="border-b border-border bg-linear-to-r from-violet-600 to-indigo-600 px-6 py-7 text-white sm:px-8">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-white/15 p-3">
              <Mail className="h-6 w-6" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/75">
                Cred-X Communications
              </p>
              <h1 className="mt-1 text-2xl font-bold">Mails</h1>
            </div>
          </div>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-white/80">
            Send the first fixed test message now. Trigger-based recipients and dedicated messages can be added here later.
          </p>
        </div>

        <div className="space-y-6 p-6 sm:p-8">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Recipients</h2>
            <label className="mt-3 flex cursor-pointer items-center gap-3 rounded-2xl border border-border bg-muted/35 p-4 transition hover:bg-muted/60">
              <input
                type="checkbox"
                checked={selected}
                onChange={(event) => setSelected(event.target.checked)}
                className="h-4 w-4 accent-violet-600"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">
                  Tarun Singh
                </span>
                <span className="block truncate text-sm text-muted-foreground">
                  {RECIPIENT}
                </span>
              </span>
            </label>
          </div>

          <div className="rounded-2xl border border-border bg-muted/25 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Message preview
            </p>
            <p className="mt-3 text-sm text-foreground">{MESSAGE}</p>
          </div>

          {success ? (
            <div role="status" className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {success}
            </div>
          ) : null}

          {failure ? (
            <div role="alert" className="space-y-4 rounded-2xl border border-red-200 bg-red-50 p-5 text-red-950">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
                <div>
                  <p className="text-sm font-bold">{failure.summary}</p>
                  <p className="mt-1 font-mono text-xs font-semibold text-red-700">
                    Error code: {failure.code}
                  </p>
                  {failure.provider_message ? (
                    <p className="mt-2 rounded-lg bg-white/70 px-3 py-2 font-mono text-xs leading-5 text-red-800">
                      Provider response: {failure.provider_message}
                    </p>
                  ) : null}
                </div>
              </div>

              {failure.configuration ? (
                <div className="grid gap-2 rounded-xl border border-red-200 bg-white/70 p-3 text-xs sm:grid-cols-2">
                  <p><span className="font-semibold">SMTP server:</span> {failure.configuration.host}:{failure.configuration.port ?? 'not set'}</p>
                  <p><span className="font-semibold">Sender:</span> {failure.configuration.from_name} &lt;{failure.configuration.from_email}&gt;</p>
                  <p><span className="font-semibold">Username:</span> {failure.configuration.username_configured ? 'Configured' : 'Missing'}</p>
                  <p><span className="font-semibold">Password:</span> {failure.configuration.password_configured ? 'Configured (hidden)' : 'Missing'}</p>
                </div>
              ) : null}

              {failure.how_to_fix.length ? (
                <div>
                  <div className="flex items-center gap-2 text-sm font-bold">
                    <Wrench className="h-4 w-4" />
                    How to fix
                  </div>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-5">
                    {failure.how_to_fix.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => void sendMail()}
            disabled={!selected || sending}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {sending ? 'Sending…' : 'Send email'}
          </button>
        </div>
      </section>

      <section className="mt-8 overflow-hidden rounded-3xl border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-3 border-b border-border px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">
              Delivery audit
            </p>
            <h2 className="mt-1 text-xl font-bold text-foreground">Sent mail history</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Automatic Stage 2 warnings and manual tests, including failures and remarks.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadHistory()}
            disabled={historyLoading}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${historyLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div className="space-y-4 p-6">
          {historyError ? (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {historyError}
            </div>
          ) : null}

          {!historyLoading && history.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No mail attempts have been recorded yet.
            </div>
          ) : null}

          {history.map((item) => {
            const statusTone =
              item.status === 'sent'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : item.status === 'failed'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800';
            return (
              <article key={item.id} className="rounded-2xl border border-border bg-muted/20 p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-wide ${statusTone}`}>
                        {item.status}
                      </span>
                      <span className="text-xs font-semibold text-violet-700">{item.trigger}</span>
                    </div>
                    <h3 className="mt-3 text-base font-bold text-foreground">{item.subject}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      To: {item.recipients.join(', ') || 'No recipient recorded'}
                    </p>
                  </div>
                  <p className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock3 className="h-3.5 w-3.5" />
                    {new Date(item.created_at).toLocaleString('en-IN')}
                  </p>
                </div>

                {item.warnings.length ? (
                  <div className="mt-4 space-y-2">
                    {item.warnings.map((warning, index) => (
                      <div key={warning.market_id || index} className="rounded-xl border border-red-200 bg-red-50/70 p-3 text-sm text-red-950">
                        <p className="font-bold">{warning.question || warning.market_id}</p>
                        <p className="mt-1">
                          Held {warning.position_side}: {warning.held_side_llm_odds}% — {warning.recommended_action || 'EXIT'}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}

                <details className="mt-4 rounded-xl border border-border bg-background p-4">
                  <summary className="cursor-pointer text-sm font-semibold text-foreground">
                    Message and delivery remarks
                  </summary>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground">{item.message}</p>
                  <p className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">
                    <span className="font-semibold text-foreground">Remarks:</span> {item.remarks || 'None'}
                  </p>
                  {item.run_id ? (
                    <p className="mt-2 font-mono text-xs text-muted-foreground">Run: {item.run_id}</p>
                  ) : null}
                  {item.provider_summary ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Provider: {item.provider_code || 'unknown'} — {item.provider_summary}
                    </p>
                  ) : null}
                  {item.provider_message ? (
                    <p className="mt-2 rounded-lg bg-red-50 p-2 font-mono text-xs text-red-800">
                      {item.provider_message}
                    </p>
                  ) : null}
                </details>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
