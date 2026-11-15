import "next-auth";
import "next-auth/jwt";

interface User {
  id: string;
  email: string;
  name?: string | null;
  username?: string;
  role?: string;
}

declare module "next-auth" {
  interface Session {
    userData?: User;
    generation?: string;
    user: {
      id?: string;
      email?: string | null;
      name?: string | null;
      username?: string;
      role?: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    accessTokenExpiresAt?: number;
    sessionGeneration?: string;
    userData?: User;
    username?: string;
    role?: string;
  }
}
