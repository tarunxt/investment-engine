'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';

import { cn } from '@/lib/utils';
import type { NavigationLeaf, NavigationSection } from './sidebarNavigationConfig';
import { ACCOUNT_NAVIGATION } from './sidebarNavigationConfig';
import { collectLeafEntries, isLeafActive } from './sidebarNavigationUtils';

type Props = {
    open: boolean;
    pathname: string;
    sections: readonly NavigationSection[];
    onClose: () => void;
    onNavigate: () => void;
};

export function NavigationDirectory({ open, pathname, sections, onClose, onNavigate }: Props) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const dialog = dialogRef.current;
        if (open) dialog?.showModal();
        else dialog?.close();
    }, [open]);

    if (typeof document === 'undefined') return null;
    const destinations: NavigationLeaf[] = [...collectLeafEntries(sections), ...ACCOUNT_NAVIGATION];
    const returnClass = 'rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2';

    return createPortal(
        <dialog
            ref={dialogRef}
            aria-labelledby="navigation-directory-title"
            onClose={onClose}
            onKeyDown={(event) => {
                if (event.key !== 'Tab') return;
                const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]');
                const first = controls[0];
                const last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }}
            className="fixed inset-0 m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl border border-sidebar-border bg-sidebar p-4 text-sidebar-foreground shadow-xl backdrop:bg-black/35 sm:p-6"
        >
            <h2 id="navigation-directory-title" className="text-lg font-semibold">All destinations</h2>
            <nav aria-label="Navigation views" className="my-4 flex flex-wrap gap-2">
                <button type="button" onClick={onClose} className={cn(returnClass, 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200')}>Primary navigation</button>
                <button type="button" aria-current="true" className={cn(returnClass, 'bg-violet-600 text-white')}>All destinations</button>
            </nav>
            <button type="button" onClick={onClose} className={cn(returnClass, 'mb-3 text-sidebar-primary underline underline-offset-4')}>Return to primary navigation</button>
            <div className="overflow-hidden rounded-xl border border-sidebar-border bg-violet-50/40 p-2 dark:bg-violet-950/20">
                <table className="w-full table-fixed text-left text-sm">
                    <thead className="bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                        <tr><th scope="col" className="w-1/2 px-3 py-2 font-semibold">Destination</th><th scope="col" className="px-3 py-2 font-semibold">Route</th></tr>
                    </thead>
                    <tbody className="divide-y divide-sidebar-border bg-white dark:bg-sidebar">
                        {destinations.map((leaf) => (
                            <tr key={leaf.id} className={isLeafActive(pathname, leaf) ? 'bg-violet-50 dark:bg-violet-950/30' : undefined}>
                                <td className="break-words px-3 py-2 align-top">
                                    <Link href={leaf.href} prefetch={false} aria-current={isLeafActive(pathname, leaf) ? 'page' : undefined} onClick={() => { onClose(); onNavigate(); }} className="rounded-sm font-medium text-sidebar-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
                                        {leaf.name}{leaf.badge ? <span className="ml-1 text-[10px] uppercase">· {leaf.badge.label}</span> : null}
                                    </Link>
                                </td>
                                <td className="break-all px-3 py-2 align-top text-xs text-muted-foreground">{leaf.href}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </dialog>, document.body,
    );
}
