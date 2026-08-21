import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { NextAuthConfig, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";

import { apiService } from "@/services/api";

export function resolveNextAuthSecret(): string {
  const configuredSecret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
  if (configuredSecret) {
    return configuredSecret;
  }

  return "local-auth-disabled-fallback-secret";
}

export const authConfig = {
  // Production runs behind nginx, so Auth.js must trust the forwarded host header.
  trustHost: true,
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: {
          label: "Email",
          type: "email",
        },
        username: {
          label: "Username",
          type: "text",
        },
        password: {
          label: "Password",
          type: "password",
        },
      },
      async authorize(credentials) {
        if (!credentials?.password) {
          throw new Error("Password is required");
        }

        const loginData: { password: string; email?: string; username?: string } = {
          password: credentials.password.toString(),
        };

        if (credentials.email) {
          loginData.email = credentials.email.toString();
        } else if (credentials.username) {
          loginData.username = credentials.username.toString();
        } else {
          throw new Error("Email or username is required");
        }

        try {
          const response = await apiService.login(loginData);

          if (!response) {
            throw new Error("Empty response from server");
          }
          if (!response.user) {
            throw new Error("User data missing");
          }

          return {
            id: response.user.id?.toString(),
            email: response.user.email,
            name: response.user.full_name || response.user.username,
            username: response.user.username,
            role: response.user.role,
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            expiresIn: response.expires_in,
            userData: response.user,
          };
        } catch (error) {
          console.error("Authorization error:", error);
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      const userObj = user as Record<string, unknown> | undefined;
      if (userObj) {
        token.id = userObj.id as string;
        token.accessToken = userObj.accessToken as string;
        token.refreshToken = userObj.refreshToken as string;
        token.userData = userObj.userData as JWT["userData"];
        token.username = userObj.username as string;
        token.role = userObj.role as string;
        token.expiresIn = userObj.expiresIn as number;
        token.accessTokenExpiresAt =
          Date.now() + Number(userObj.expiresIn || 15 * 60) * 1_000;
        token.sessionGeneration = crypto.randomUUID();
      }

      // Browser and server route refreshes both use Auth.js's update trigger so
      // hard navigations cannot restore the access token that just returned 401.
      if (trigger === "update") {
        const update = session as Record<string, unknown> | undefined;
        const accessToken = update?.accessToken;
        const refreshToken = update?.refreshToken;
        const expiresIn = update?.expiresIn;

        if (
          typeof accessToken === "string" &&
          accessToken &&
          typeof refreshToken === "string" &&
          refreshToken
        ) {
          token.accessToken = accessToken;
          token.refreshToken = refreshToken;
          if (
            typeof expiresIn === "number" &&
            Number.isFinite(expiresIn) &&
            expiresIn > 0
          ) {
            token.expiresIn = expiresIn;
            token.accessTokenExpiresAt = Date.now() + expiresIn * 1_000;
          }
        }
      }

      return token;
    },
    async session({ session, token }: { session: Session; token: JWT }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.username = token.username as string;
        session.user.role = token.role as string;
      }

      session.userData = token.userData
        ? { ...token.userData }
        : token.userData;
      session.generation =
        typeof token.sessionGeneration === "string"
          ? token.sessionGeneration
          : `${String(token.id || token.sub || "")}:${String(token.iat || "")}`;

      return session;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60,
  },
  secret: resolveNextAuthSecret(),
} satisfies NextAuthConfig;

export const { handlers, auth, unstable_update } = NextAuth(authConfig);
