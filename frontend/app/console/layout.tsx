import { redirect } from "next/navigation";
import type { Session } from "next-auth";

import { auth } from "@/auth";
import { ConsoleProviders } from "@/providers/ConsoleProviders";
import type { UserResponse } from "@/types/api";

import { ConsoleShell } from "./_components/ConsoleShell";

function safeSessionUser(session: Session) {
  const userData = session.userData as unknown as UserResponse | undefined;
  if (userData) {
    return {
      id: userData.id,
      email: userData.email,
      username: userData.username,
      full_name: userData.full_name,
      role: userData.role,
      is_active: userData.is_active,
      is_verified: userData.is_verified,
      created_at: userData.created_at,
      updated_at: userData.updated_at,
      last_login: userData.last_login,
      profile: userData.profile
        ? {
            user_id: userData.profile.user_id,
            avatar_url: userData.profile.avatar_url,
            bio: userData.profile.bio,
            timezone: userData.profile.timezone,
            notification_preferences:
              userData.profile.notification_preferences,
            theme_preference: userData.profile.theme_preference,
            created_at: userData.profile.created_at,
            updated_at: userData.profile.updated_at,
          }
        : null,
    } satisfies UserResponse;
  }

  const id = Number(session.user?.id);
  if (!Number.isFinite(id) || !session.user?.email) return null;
  const now = new Date(0).toISOString();
  return {
    id,
    email: session.user.email,
    username: session.user.username || session.user.email,
    full_name: session.user.name ?? null,
    role: session.user.role || "user",
    is_active: true,
    is_verified: true,
    created_at: now,
    updated_at: now,
    last_login: null,
    profile: null,
  } satisfies UserResponse;
}

export default async function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const initialUser = safeSessionUser(session);
  if (!initialUser) redirect("/login");

  return (
    <ConsoleProviders
      initialUser={initialUser}
      initialSession={{
        expires: session.expires,
        user: {
          id: String(initialUser.id),
          email: initialUser.email,
          name: initialUser.full_name,
          username: initialUser.username,
          role: initialUser.role,
        },
      }}
    >
      <ConsoleShell>{children}</ConsoleShell>
    </ConsoleProviders>
  );
}
