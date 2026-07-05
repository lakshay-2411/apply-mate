import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { saveRefreshToken } from "@/lib/supabase";

/**
 * NextAuth (Auth.js) v5 configuration.
 *
 * We request the `gmail.send` scope plus `access_type=offline` and
 * `prompt=consent` so Google returns a long-lived refresh token. That
 * refresh token is persisted to Supabase on first sign-in and later used
 * server-side to mint short-lived access tokens for sending mail.
 */
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      authorization: {
        params: {
          scope: `openid email profile ${GMAIL_SCOPE}`,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account, profile }) {
      // `account` is only present on the initial sign-in.
      if (account?.refresh_token && (profile?.email || token.email)) {
        const email = (profile?.email ?? token.email) as string;
        const name = (profile?.name ?? token.name ?? null) as string | null;
        token.email = email;
        token.name = name;
        await saveRefreshToken(email, name, account.refresh_token);
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.email = (token.email as string) ?? session.user.email;
        session.user.name = (token.name as string) ?? session.user.name;
      }
      return session;
    },
  },
});
