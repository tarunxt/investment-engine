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

  if(process.env.NEXT_PUBLIC_UAT2==='true'){
    if(pathname==='/console/profile/get-started'||pathname==='/console/profile/modules'||pathname==='/console/profile/activity')return <>{children}</>;
    const privacyReview=pathname.startsWith('/console/profile/privacy/requests');
    const tabs=pathname==='/console/profile/privacy'?[['Modules','/console/profile/modules'],['Appearance','/console/profile/preferences'],['Connections','/console/profile/connections'],['Privacy & utilities','/console/profile/privacy']]:pathname==='/console/profile/research-library'?[['Prompt library','/console/profile/research-library'],['Usage & costs','/console/profile/usage'],['Connections','/console/profile/connections'],['Help','/console/help']]:[['Profile','/console/profile'],['Modules','/console/profile/modules'],['Appearance','/console/profile/preferences'],['Account utilities','/console/profile/privacy']];
    return <section className={pathname==='/console/profile'?'concept-f-account-page space-y-6':pathname.startsWith('/console/profile/privacy')||pathname==='/console/profile/research-library'?'concept-f-account-utility-page space-y-6':'space-y-6'}><header><h1 className="text-3xl font-bold">{pathname.startsWith('/console/profile/privacy/requests')?'Privacy scope is explicit':pathname==='/console/profile/privacy'?'Account utilities, with honest limits':pathname==='/console/profile/research-library'?'Your research library and usage':'A workspace that feels like yours'}</h1><p className="mt-2 text-sm text-muted-foreground">{privacyReview?'Profile / Privacy / coverage, review requests and history':pathname==='/console/profile/privacy'?'Profile / account utilities / no hidden admin navigation':'Profile and preferences / controls stay easy to find'}</p></header>{!privacyReview&&<nav aria-label="Profile settings" className="concept-f-account-tabs">{tabs.map(([title,href])=><Link key={href} href={href} prefetch={false} aria-current={pathname===href?'page':undefined}>{title}</Link>)}<details><summary>More account tools</summary><div className="concept-f-card mt-3 flex flex-wrap gap-4">{[{title:'Research library',href:'/console/profile/research-library'},...sidebarNavItems].filter(item=>item.title!=='Platform Cost Drivers'||costAccessOwner===user?.id).map(item=><Link key={item.href} href={item.href} prefetch={false}>{item.title}</Link>)}</div></details></nav>}{children}</section>;
  }

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
