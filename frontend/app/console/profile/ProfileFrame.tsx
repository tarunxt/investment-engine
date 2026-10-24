"use client";

import {useAuth} from '@/hooks/useAuth';
import { URLs } from "@/lib/urls";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const sidebarNavItems = [
  {title: "Get started",href: "/console/profile/get-started"},
  {title: "Connections",href: "/console/profile/connections"},
  {title: "My modules",href: "/console/profile/preferences#modules"},
  {title: "Usage & plan",href: "/console/profile/usage"},
  {title: "Notifications",href: "/console/profile/preferences#notification-settings"},
  {title: "Privacy & exports",href: "/console/profile/privacy"},
  {title: "Help",href: "/console/help"},
  {
    title: "Profile",
    href: URLs.routes.profile.root(),
  },
  {
    title: "Preferences",
    href: URLs.routes.profile.preferences(),
  },
  {
    title: "Platform Cost Drivers",
    href: URLs.routes.profile.costDrivers(),
  },
  {
    title: "Security",
    href: URLs.routes.profile.security(),
  },
  {
    title: "My Activity",
    href: URLs.routes.profile.activity(),
  },
];

interface SettingsLayoutProps {
  children: React.ReactNode;
}

export function ProfileFrame({ children, costAccessOwner }: SettingsLayoutProps & {costAccessOwner:number|null}) {
  const pathname = usePathname();
  const {user}=useAuth();

  return (
    <div className="space-y-6 pb-16 md:block">
      <div className="space-y-0.5">
        <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
        <p className="text-muted-foreground">
          Manage your account settings and preferences.
        </p>
      </div>
      <div className="shrink-0 bg-border h-px w-full" />
      <div className="flex flex-col space-y-8 lg:flex-row lg:space-x-12 lg:space-y-0">
        <aside className="-mx-4 lg:w-1/5">
          <nav
            aria-label="Profile settings"
            className={cn(
              "flex flex-wrap gap-2 lg:flex-col lg:flex-nowrap lg:gap-1",
              "px-4"
            )}
          >
            {sidebarNavItems.filter(item=>item.title!=='Platform Cost Drivers'||costAccessOwner===user?.id).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname === item.href ? "page" : undefined}
                className={cn(
                  "inline-flex items-center whitespace-normal rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                  "hover:bg-muted hover:text-muted-foreground",
                  "min-h-11 px-4 py-2 justify-start",
                  pathname === item.href
                    ? "bg-muted font-medium text-primary"
                    : "text-muted-foreground"
                )}
              >
                {item.title}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="min-w-0 flex-1 pl-3 lg:max-w-none">{children}</div>
      </div>
    </div>
  );
}
