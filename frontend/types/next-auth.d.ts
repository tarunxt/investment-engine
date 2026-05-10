import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    accessToken?: string;
    refreshToken?: string;
    userData?: any;
    user: {
      id?: string;
      email?: string | null;
      name?: string | null;
      username?: string;
      role?: string;
    } & DefaultSession["user"];
  }

  interface User {
    id: string;
    email: string;
    name?: string | null;
    username?: string;
    role?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    userData?: any;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    accessToken?: string;
    refreshToken?: string;
    userData?: any;
    username?: string;
    role?: string;
  }
}