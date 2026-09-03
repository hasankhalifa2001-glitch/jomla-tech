"use server";

import { signOut } from "@/auth";

/**
 * Server action wrapping NextAuth's signOut() for use in a plain <form
 * action={...}> — needed because app/(locked)/account-locked/page.tsx is a
 * server component with no client-side onClick handler available. Redirects
 * to /login by default (NextAuth's own post-signout behavior via the
 * `pages.signIn` config in auth.ts).
 */
export async function signOutAction() {
    await signOut({ redirectTo: "/login" });
}