'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ACCOUNT_ACTIONS, ACCOUNT_NAVIGATION, SIDEBAR_SECTIONS } from '@/app/console/_components/sidebarNavigationConfig';
import { collectLeafEntries } from '@/app/console/_components/sidebarNavigationUtils';
import { isSidebarPolicy, SIDEBAR_POLICY_CHANGED, type SidebarPolicy } from '@/lib/sidebarVisibility';
import { apiService } from '@/services/api';

const account = [...ACCOUNT_NAVIGATION, { id: 'appearance', name: ACCOUNT_ACTIONS.appearanceLabel }];
const allIds = [...collectLeafEntries(SIDEBAR_SECTIONS), ...account].map((item) => item.id);
const control = 'size-4 shrink-0 accent-violet-600';
const button = 'rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50';

function checkedIds(policy: SidebarPolicy) {
    return new Set(policy.visible_ids ?? allIds);
}

function GroupToggle({ label, ids, selected, onChange }: {
    label: string;
    ids: string[];
    selected: Set<string>;
    onChange: (ids: string[], checked: boolean) => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    const count = ids.filter((id) => selected.has(id)).length;
    useEffect(() => {
        if (input.current) input.current.indeterminate = count > 0 && count < ids.length;
    }, [count, ids.length]);
    return <label className="flex cursor-pointer items-center gap-3 py-2 font-medium">
        <input ref={input} className={control} type="checkbox" checked={count === ids.length}
            onChange={(event) => onChange(ids, event.target.checked)} />
        {label}
    </label>;
}

export function SidebarSettings() {
    const [saved, setSaved] = useState<SidebarPolicy | null>(null);
    const [selected, setSelected] = useState(new Set<string>());
    const [attempt, setAttempt] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    useEffect(() => {
        let active = true;
        apiService.getSidebarPolicy().then((policy) => {
            if (!isSidebarPolicy(policy) || !policy.can_manage) throw new Error('Owner access required.');
            if (active) {
                setSaved(policy);
                setSelected(checkedIds(policy));
            }
        }).catch(() => { if (active) setError('Couldn’t load your sidebar settings.'); });
        return () => { active = false; };
    }, [attempt]);

    function reload() {
        setSaved(null);
        setError('');
        setNotice('');
        setAttempt((value) => value + 1);
    }
    function toggle(ids: string[], checked: boolean) {
        setNotice('');
        setSelected((previous) => {
            const next = new Set(previous);
            for (const id of ids) {
                if (checked) next.add(id);
                else next.delete(id);
            }
            return next;
        });
    }
    const baseline = saved && checkedIds(saved);
    const dirty = baseline && allIds.some((id) => baseline.has(id) !== selected.has(id));
    async function save() {
        if (!saved || busy || !dirty) return;
        setBusy(true);
        setError('');
        setNotice('');
        try {
            const policy = await apiService.saveSidebarPolicy([...selected], saved.revision);
            if (!isSidebarPolicy(policy) || !policy.can_manage) throw new Error('Invalid settings response.');
            setSaved(policy);
            setSelected(checkedIds(policy));
            setNotice('Sidebar visibility saved.');
            window.dispatchEvent(new Event(SIDEBAR_POLICY_CHANGED));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Couldn’t save sidebar settings.');
        } finally {
            setBusy(false);
        }
    }
    function item(option: {id: string; name: string}) {
        return <label key={option.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted">
            <input type="checkbox" className={control} checked={selected.has(option.id)}
                onChange={(event) => toggle([option.id], event.target.checked)} />
            {option.name}
        </label>;
    }
    return <main className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8">
        <Link href="/console/dashboard" className="text-sm font-medium text-primary underline underline-offset-4">Back to console</Link>
        <header className="mb-6 mt-6 space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight">Sidebar visibility</h1>
            <p className="text-muted-foreground">Choose the options shown to every Cred-X user, including new accounts.</p>
        </header>
        {saved && <fieldset disabled={busy} className="grid items-start gap-4 sm:grid-cols-2">
            <legend className="sr-only">Sidebar options</legend>
            {SIDEBAR_SECTIONS.map((section) => <section key={section.id} className="rounded-2xl border border-border bg-card p-5">
                <h2 className="mb-2 font-semibold">{section.label}</h2>
                {section.entries.map((entry) => entry.type === 'item' ? item(entry) :
                    <div key={entry.id} className="px-2">
                        <GroupToggle label={entry.name} ids={entry.children.map((child) => child.id)} selected={selected} onChange={toggle} />
                        <div className="ml-2 border-l border-border pl-4">{entry.children.map(item)}</div>
                    </div>)}
            </section>)}
            <section className="rounded-2xl border border-border bg-card p-5">
                <h2 className="mb-2 font-semibold">Account</h2>
                {account.map(item)}
                <p className="mt-2 text-sm text-muted-foreground">Sign out is always available.</p>
            </section>
        </fieldset>}
        {!saved && !error && <p role="status">Loading settings…</p>}
        {error && <div role="alert" className="my-4 rounded-lg border border-border p-4">
            <p>{error}</p><button className="mt-2 underline" onClick={reload}>Reload saved selection</button>
        </div>}
        {saved && <footer className="sticky bottom-0 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
            <span role="status" className="mr-auto text-sm">{notice || `${selected.size} of ${allIds.length} options visible`}</span>
            <button className={button} disabled={!dirty || busy} onClick={() => { setSelected(checkedIds(saved)); setError(''); }}>Discard changes</button>
            <button className="rounded-lg bg-violet-700 px-4 py-2 font-semibold text-white hover:bg-violet-800 disabled:opacity-50"
                disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
        </footer>}
    </main>;
}
