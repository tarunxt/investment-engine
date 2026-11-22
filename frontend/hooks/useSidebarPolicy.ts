'use client';

import { useEffect, useState } from 'react';
import { apiService } from '@/services/api';
import { isSidebarPolicy, SIDEBAR_POLICY_CHANGED, type SidebarPolicy } from '@/lib/sidebarVisibility';

export function useSidebarPolicy(userId: number | undefined) {
    const [record, setRecord] = useState<{userId: number; policy: SidebarPolicy | null} | null>(null);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (userId === undefined) return;
        let generation = 0;
        const load = async () => {
            const request = ++generation;
            try {
                const policy = await apiService.getSidebarPolicy();
                if (!isSidebarPolicy(policy)) throw new Error('Invalid sidebar settings');
                if (request === generation) setRecord({ userId, policy });
            } catch {
                if (request === generation) setRecord({ userId, policy: null });
            }
        };
        const refreshVisible = () => { if (!document.hidden) void load(); };
        void load();
        const timer = window.setInterval(refreshVisible, 60_000);
        document.addEventListener('visibilitychange', refreshVisible);
        window.addEventListener('online', refreshVisible);
        window.addEventListener(SIDEBAR_POLICY_CHANGED, refreshVisible);
        return () => {
            ++generation;
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', refreshVisible);
            window.removeEventListener('online', refreshVisible);
            window.removeEventListener(SIDEBAR_POLICY_CHANGED, refreshVisible);
        };
    }, [userId, attempt]);

    return {
        policy: record && record.userId === userId ? record.policy : undefined,
        retry: () => setAttempt((value) => value + 1),
    };
}
