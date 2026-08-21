'use client';

import { useState } from 'react';
import { CheckCircle2, Mail, Send } from 'lucide-react';

import { URLs } from '@/lib/urls';

const RECIPIENT = 'tarun.singh6893@gmail.com';
const MESSAGE = "Hi, this a message from Tarun's Cred-X";

export default function MailsPage() {
  const [selected, setSelected] = useState(true);
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function sendMail() {
    if (!selected || sending) return;

    setSending(true);
    setSuccess(null);
    setError(null);

    try {
      const response = await fetch(URLs.mails.sendTest(), {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          payload?.detail || payload?.message || 'The email could not be sent.',
        );
      }

      setSuccess(`Email sent successfully to ${RECIPIENT}.`);
    } catch (sendError) {
      setError(
        sendError instanceof Error
          ? sendError.message
          : 'The email could not be sent.',
      );
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

          {error ? (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
              {error}
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
    </main>
  );
}
