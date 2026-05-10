import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { NextAuthConfig } from "next-auth";
import { apiService } from "@/services/api";

export const authConfig: NextAuthConfig = {
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

        const loginData: any = {
          password: credentials.password,
        };

        if (credentials.email) {
          loginData.email = credentials.email;
        } else if (credentials.username) {
          loginData.username = credentials.username;
        } else {
          throw new Error("Email or username is required");
        }

        try {
          const response = await apiService.login(loginData);

          console.log("LOGIN RESPONSE:", response);

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
    async jwt({ token, user }: any) {
      if (user) {
        token.id = user.id;
        token.accessToken = user.accessToken;
        token.refreshToken = user.refreshToken;
        token.userData = user.userData;
        token.username = user.username;
        token.role = user.role;
      }

      return token;
    },

    async session({ session, token }: any) {
      if (session.user) {
        session.user.id = token.id;
        session.user.username = token.username;
        session.user.role = token.role;
      }

      session.accessToken = token.accessToken;
      session.refreshToken = token.refreshToken;
      session.userData = token.userData;

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

  secret: process.env.NEXTAUTH_SECRET,
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export const { GET, POST } = handlers;
