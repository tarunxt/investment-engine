import type { ComponentType } from 'react';
import {
    Bot,
    BriefcaseBusiness,
    Database,
    History,
    LayoutDashboard,
    LogOut,
    Mail,
    Plug2,
    ReceiptText,
    ScanSearch,
    Settings2,
    Sparkles,
    UserRound,
} from 'lucide-react';

import { URLs } from '../../../lib/urls';

export type NavigationIcon = ComponentType<{ className?: string }>;
export type NavigationLeafMatchMode = 'exact' | 'prefix';
export type NavigationBadgeVariant = 'live' | 'review' | 'direct' | 'default';

export type NavigationBadge = {
    label: string;
    variant: NavigationBadgeVariant;
};

export type NavigationLeaf = {
    type: 'item';
    id: string;
    name: string;
    href: string;
    matchMode?: NavigationLeafMatchMode;
    icon?: NavigationIcon;
    title?: string;
    badge?: NavigationBadge;
};

export type NavigationGroup = {
    type: 'group';
    id: string;
    name: string;
    icon: NavigationIcon;
    children: readonly NavigationLeaf[];
};

export type NavigationEntry = NavigationLeaf | NavigationGroup;
export type SidebarSectionId = 'overview' | 'investing' | 'ai-workspace' | 'monitoring' | 'platform';

export type NavigationSection = {
    id: SidebarSectionId;
    label: string;
    entries: readonly NavigationEntry[];
};

export type AccountNavigationItem = NavigationLeaf & {
    icon: NavigationIcon;
};

export const SIDEBAR_SECTIONS = [
    {
        id: 'overview',
        label: 'Home',
        entries: [
            {
                type: 'item',
                id: 'overview',
                name: 'Dashboard',
                href: URLs.routes.console.dashboard(),
                icon: LayoutDashboard,
                matchMode: 'exact',
            },
        ],
    },
    {
        id: 'investing',
        label: 'Investing',
        entries: [
            {
                type: 'group',
                id: 'portfolios',
                name: 'Portfolios',
                icon: BriefcaseBusiness,
                children: [
                    {
                        type: 'item',
                        id: 'india-portfolio',
                        name: 'India Portfolio',
                        href: URLs.routes.console.zerodha(),
                        matchMode: 'prefix',
                        title: 'India Portfolio — Connected through Zerodha',
                    },
                    {
                        type: 'item',
                        id: 'us-portfolio',
                        name: 'US Portfolio',
                        href: URLs.routes.console.indmoneyUs(),
                        matchMode: 'prefix',
                        title: 'US Portfolio — Connected through INDmoney',
                    },
                    {
                        type: 'item',
                        id: 'automated-rebalance',
                        name: 'Automated Rebalance',
                        href: URLs.routes.console.automatedRebalance(),
                        matchMode: 'exact',
                    },
                ],
            },
            {
                type: 'group',
                id: 'trading-bots',
                name: 'Trading Bots',
                icon: Bot,
                children: [
                    {
                        type: 'item',
                        id: 'bot-overview',
                        name: 'Bot Overview',
                        href: URLs.routes.console.tradingBots(),
                        matchMode: 'exact',
                    },
                    {
                        type: 'item',
                        id: 'bullpen-ai-review',
                        // Legacy compatibility label: name: 'Bullpen Review'.
                        name: 'Bullpen 007',
                        href: URLs.routes.console.bullpenAi(),
                        matchMode: 'prefix',
                        badge: {
                            label: 'Review',
                            variant: 'review',
                        },
                    },
                    {
                        type: 'item',
                        id: 'bullpen008',
                        name: 'Bullpen 008',
                        href: URLs.routes.console.bullpen008(),
                        matchMode: 'prefix',
                        badge: {
                            label: 'Shadow',
                            variant: 'review',
                        },
                    },
                    {
                        type: 'item',
                        id: 'bullpen-ai-live',
                        name: 'Bullpen Live',
                        href: URLs.routes.console.bullpenAiAutoLive(),
                        matchMode: 'prefix',
                        badge: {
                            label: 'Live',
                            variant: 'live',
                        },
                    },
                    {
                        type: 'item',
                        id: 'bullpen-copy-trader',
                        name: 'Copy Trader',
                        href: URLs.routes.console.polymarketBot(),
                        matchMode: 'prefix',
                    },
                    {
                        type: 'item',
                        id: 'polymarket-direct',
                        name: 'Polymarket Direct',
                        href: URLs.routes.console.polymarketDirectBot(),
                        matchMode: 'prefix',
                        badge: {
                            label: 'Direct',
                            variant: 'direct',
                        },
                    },
                ],
            },
            {
                type: 'item',
                id: 'market-scanner',
                name: 'Market Scanner',
                href: URLs.routes.console.technicalSetups(),
                icon: ScanSearch,
                matchMode: 'prefix',
            },
        ],
    },
    {
        id: 'ai-workspace',
        label: 'AI & Automation',
        entries: [
            {
                type: 'group',
                id: 'ai-studio',
                name: 'AI Studio',
                icon: Sparkles,
                children: [
                    {
                        type: 'item',
                        id: 'prompt-library',
                        name: 'Prompt Library',
                        href: URLs.routes.console.prompts(),
                        matchMode: 'prefix',
                    },
                    {
                        type: 'item',
                        id: 'ai-models',
                        name: 'AI Models',
                        href: URLs.routes.console.llms(),
                        matchMode: 'prefix',
                    },
                ],
            },
        ],
    },
    {
        id: 'monitoring',
        label: 'Monitoring',
        entries: [
            {
                type: 'item',
                id: 'run-history',
                name: 'Run History',
                href: URLs.routes.console.runs(),
                icon: History,
                matchMode: 'prefix',
            },
            {
                type: 'item',
                id: 'mails',
                name: 'Alerts & Emails',
                href: URLs.routes.console.mails(),
                icon: Mail,
                matchMode: 'prefix',
            },
        ],
    },
    {
        id: 'platform',
        label: 'Data & Integrations',
        entries: [
            {
                type: 'item',
                id: 'database',
                name: 'Database',
                href: URLs.routes.console.database(),
                icon: Database,
                matchMode: 'prefix',
                title: 'Open the database viewer',
            },
            {
                type: 'group',
                id: 'integrations',
                name: 'Integrations',
                icon: Plug2,
                children: [
                    {
                        type: 'item',
                        id: 'api-connections',
                        name: 'API Connections',
                        href: URLs.routes.console.apis(),
                        matchMode: 'prefix',
                    },
                    {
                        type: 'item',
                        id: 'google-sheets',
                        name: 'Google Sheets',
                        href: URLs.routes.console.googleSheets(),
                        matchMode: 'prefix',
                    },
                ],
            },
        ],
    },
] satisfies readonly NavigationSection[];

export const ACCOUNT_NAVIGATION = [
    {
        type: 'item',
        id: 'profile',
        name: 'Profile',
        href: URLs.routes.profile.root(),
        icon: UserRound,
        matchMode: 'exact',
    },
    {
        type: 'item',
        id: 'preferences',
        name: 'Preferences',
        href: URLs.routes.profile.preferences(),
        icon: Settings2,
        matchMode: 'prefix',
    },
    {
        type: 'item',
        id: 'usage-costs',
        name: 'Usage & Costs',
        href: URLs.routes.profile.costDrivers(),
        icon: ReceiptText,
        matchMode: 'prefix',
    },
] satisfies readonly AccountNavigationItem[];

export const ACCOUNT_ACTIONS = {
    appearanceLabel: 'Appearance',
    logout: {
        label: 'Sign out',
        icon: LogOut,
    },
} as const;
