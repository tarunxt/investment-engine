'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ACCOUNT_ACTIONS, ACCOUNT_NAVIGATION, SIDEBAR_SECTIONS } from '@/app/console/_components/sidebarNavigationConfig';
import { collectLeafEntries } from '@/app/console/_components/sidebarNavigationUtils';
import { sidebarSelection, SIDEBAR_POLICY_CHANGED, type SidebarSettingsRecord, type SidebarMode, type SidebarAccount } from '@/lib/sidebarVisibility';
import { AccountPicker } from './AccountPicker';
import { apiService } from '@/services/api';

const accountOptions = [...ACCOUNT_NAVIGATION, { id: 'appearance', name: ACCOUNT_ACTIONS.appearanceLabel }];
const allIds = [...collectLeafEntries(SIDEBAR_SECTIONS), ...accountOptions].map((item) => item.id);
const control = 'size-4 shrink-0 accent-violet-600';
const button = 'rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50';

function checkedIds(policy: SidebarSettingsRecord) {
    return sidebarSelection(policy.visible_ids ?? allIds);
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
    const [scope, setScope] = useState<'global' | 'user'>('global');
    const [account, setAccount] = useState<SidebarAccount | null>(null);
    const [editing, setEditing] = useState(false);
    return <main className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8">
        <Link href="/console/dashboard" className="text-sm font-medium text-primary underline underline-offset-4">Back to console</Link>
        <header className="mb-5 mt-6 space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight">Sidebar visibility</h1>
            <p className="text-muted-foreground">Set the defaults for all accounts or customize one user’s sidebar.</p>
        </header>
        <div className="mb-5 rounded-2xl border border-border bg-card p-4">
            <div role="group" aria-label="Settings scope" className="flex gap-2">
                {(['global', 'user'] as const).map((value) => <button key={value} disabled={editing}
                    aria-pressed={scope === value} onClick={() => setScope(value)}
                    className={`${button} ${scope === value ? 'border-violet-600 text-violet-700 dark:text-violet-300' : ''}`}>
                    {value === 'global' ? 'All users' : 'Selected user'}
                </button>)}
            </div>
            {scope === 'user' && <AccountPicker selected={account} disabled={editing} onSelect={setAccount} />}
            {editing && <p className="mt-2 text-sm text-muted-foreground">Save or discard your changes to switch accounts.</p>}
        </div>
        {(scope === 'global' || account) && <SelectionEditor key={scope === 'global' ? 'global' : account!.id}
            account={scope === 'global' ? null : account} onEditing={setEditing} />}
    </main>;
}

function SelectionEditor({ account, onEditing }: {account: SidebarAccount | null; onEditing: (value: boolean) => void}) {
    const userId = account?.id ?? null;
    const [saved, setSaved] = useState<SidebarSettingsRecord | null>(null);
    const [mode, setMode] = useState<SidebarMode>('inherit');
    const [selected, setSelected] = useState(new Set<string>());
    const [attempt, setAttempt] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    useEffect(() => {
        let active = true;
        apiService.getSidebarSettings(userId).then((policy) => {
            if (active) {
                setSaved(policy);
                setMode(policy.mode);
                setSelected(checkedIds(policy));
            }
        }).catch(() => { if (active) setError('Couldn’t load your sidebar settings.'); });
        return () => { active = false; };
    }, [attempt, userId]);

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
    const dirty = Boolean(saved && baseline && (mode !== saved.mode || allIds.some((id) => baseline.has(id) !== selected.has(id))));
    useEffect(() => { onEditing(dirty || busy); }, [dirty, busy, onEditing]);
    const defaults = sidebarSelection(saved?.global_ids ?? allIds);
    const effective = mode === 'custom' ? selected : mode === 'inherit' ? defaults : new Set([...defaults, ...selected]);
    function changeMode(next: SidebarMode) {
        setMode(next);
        setNotice('');
        if (next === saved?.mode) setSelected(checkedIds(saved));
        else if (next === 'custom') setSelected(new Set(effective));
        else if (next === 'extra') setSelected(new Set([...effective].filter((id) => !defaults.has(id))));
        else setSelected(new Set());
    }
    async function save() {
        if (!saved || busy || !dirty) return;
        setBusy(true);
        setError('');
        setNotice('');
        try {
            const policy = await apiService.saveSidebarSettings(userId, mode, [...selected], saved.revision);
            setSaved(policy);
            setSelected(checkedIds(policy));
            setNotice(account ? `Saved for ${account.email}.` : 'Global defaults saved.');
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
            {mode === 'extra' && defaults.has(option.id) && <span className="ml-auto text-xs text-muted-foreground">Global</span>}
        </label>;
    }
    return <>
        {saved && <div className="mb-4 space-y-2">
            <h2 className="break-words text-xl font-semibold">{account ? account.email : 'Global defaults'}</h2>
            {account ? <label className="grid max-w-sm gap-1 text-sm font-medium">Sidebar rule
                <select value={mode} disabled={busy} onChange={(event) => changeMode(event.target.value as SidebarMode)}
                    className="rounded-lg border border-border bg-background px-3 py-2">
                    <option value="inherit">Use global defaults</option>
                    <option value="extra">Add options to global defaults</option>
                    <option value="custom">Use an exact custom list</option>
                </select>
            </label> : null}
            <p className="text-sm text-muted-foreground">{!account ? 'Applies to new and existing users who follow global defaults.' :
                mode === 'extra' ? 'Check the extra options. This account also gets every global option.' :
                mode === 'custom' ? 'Only the checked options appear for this account.' :
                'This account follows the global defaults, including future changes.'}</p>
        </div>}
        {saved && mode !== 'inherit' && <div className="mb-3 flex gap-2">
            <button className={button} disabled={busy} onClick={() => toggle(allIds, true)}>Select all</button>
            <button className={button} disabled={busy} onClick={() => toggle(allIds, false)}>Clear selection</button>
        </div>}
        {saved && mode !== 'inherit' && <fieldset disabled={busy} className="grid items-start gap-4 sm:grid-cols-2">
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
                {accountOptions.map(item)}
                <p className="mt-2 text-sm text-muted-foreground">Sign out is always available.</p>
            </section>
        </fieldset>}
        {!saved && !error && <p role="status">Loading settings…</p>}
        {error && <div role="alert" className="my-4 rounded-lg border border-border p-4">
            <p>{error}</p><button className="mt-2 underline" onClick={reload}>Reload saved selection</button>
        </div>}
        {saved && <footer className="sticky bottom-0 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
            <span role="status" className="mr-auto text-sm">{notice || `${effective.size} of ${allIds.length} options visible`}</span>
            <button className={button} disabled={!dirty || busy} onClick={() => { setMode(saved.mode); setSelected(checkedIds(saved)); setError(''); }}>Discard changes</button>
            <button className="rounded-lg bg-violet-700 px-4 py-2 font-semibold text-white hover:bg-violet-800 disabled:opacity-50"
                disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
        </footer>}
    </>;
}
