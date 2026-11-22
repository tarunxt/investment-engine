'use client';

import { useEffect, useState } from 'react';
import { apiService } from '@/services/api';
import type { SidebarAccount } from '@/lib/sidebarVisibility';

export function AccountPicker({ selected, disabled, onSelect }: {
    selected: SidebarAccount | null;
    disabled: boolean;
    onSelect: (user: SidebarAccount) => void;
}) {
    const [query, setQuery] = useState('');
    const [options, setOptions] = useState<SidebarAccount[]>([]);
    const [status, setStatus] = useState('');
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let current = true;
        const timer = setTimeout(async () => {
            try {
                const matches = await apiService.findSidebarAccounts(query);
                if (current) {
                    setOptions(matches);
                    setStatus(matches.length ? '' : 'No matching accounts.');
                }
            } catch {
                if (current) { setOptions([]); setStatus('Couldn’t load accounts.'); }
            }
        }, 200);
        return () => { current = false; clearTimeout(timer); };
    }, [query, attempt]);
    const listed = selected && !options.some((item) => item.id === selected.id) ? [selected, ...options] : options;
    return <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium">Search accounts
            <input type="search" value={query} maxLength={255} placeholder="Email or username" disabled={disabled}
                onChange={(event) => { setQuery(event.target.value); setOptions([]); setStatus('Searching…'); }}
                className="rounded-lg border border-border bg-background px-3 py-2" />
        </label>
        <label className="grid gap-1 text-sm font-medium">Selected account
            <select value={selected?.id ?? ''} disabled={disabled} onChange={(event) => {
                const user = listed.find((item) => item.id === Number(event.target.value));
                if (user) onSelect(user);
            }} className="min-w-0 rounded-lg border border-border bg-background px-3 py-2">
                <option value="" disabled>Choose an account</option>
                {listed.map((item) => <option key={item.id} value={item.id}>{item.email} ({item.username})</option>)}
            </select>
        </label>
        {status && <p role="status" className="text-sm text-muted-foreground">{status}
            {status === 'Couldn’t load accounts.' && <button onClick={() => setAttempt((v) => v + 1)} className="ml-2 underline">Retry</button>}
        </p>}
    </div>;
}
