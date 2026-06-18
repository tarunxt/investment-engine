"use client";

import { URLs } from "@/lib/urls";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const sidebarNavItems = [
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
    title: "Activity",
    href: URLs.routes.profile.activity(),
  },
];

interface SettingsLayoutProps {
  children: React.ReactNode;
}

export default function SettingsLayout({ children }: SettingsLayoutProps) {
  const pathname = usePathname();

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
            className={cn(
              "flex space-x-2 lg:flex-col lg:space-x-0 lg:space-y-1",
              "px-4"
            )}
          >
            {sidebarNavItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "inline-flex items-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                  "hover:bg-muted hover:text-muted-foreground",
                  "h-9 px-4 py-2 justify-start",
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
        <div className="flex-1 lg:max-w-2xl pl-3">{children}</div>
      </div>
    </div>
  );
}
