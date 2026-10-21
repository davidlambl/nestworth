import React, { createContext, useContext, useEffect, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabase';
import { describeRequestError } from './requestError';
import { forgetReceiptUrls } from './receiptStorage';

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // lib/query.tsx's client: QueryProvider wraps this provider (app/_layout.tsx).
  const queryClient = useQueryClient();
  // The cache and the kept receipt URLs are emptied as this provider mounts,
  // before anything under it renders (#177). The client outlives the
  // provider: the root layout's ErrorBoundary takes the provider down on a
  // render error and mounts it again on Retry, over the same cache, whose
  // account it cannot know (another tab of the app may have signed out, or
  // signed another account in, meanwhile). The screens it renders while it
  // loads, before any session, would be handed what that cache holds: a
  // query disabled for want of a user still returns its cached data. At
  // launch there is nothing to remove.
  useState(() => {
    queryClient.removeQueries();
    forgetReceiptUrls();
  });

  useEffect(() => {
    // The account the screens were last handed by this provider; unknown
    // until the first session is. Every query the app makes reads that
    // account's rows, under a key that does not name it (['accounts'],
    // ['transaction', id], ...), and TanStack keeps a result fresh for 30 s
    // and in memory for 5 min (lib/query.tsx). So when the account changes,
    // every query is removed before the new session reaches a screen, which
    // would otherwise be handed the previous account's accounts, register and
    // transaction out of the cache, without a read (#177). On a change of
    // account, not on SIGNED_OUT alone: on web the sign-in screen is reachable
    // by its URL while signed in, and a sign-in there is reported as
    // SIGNED_IN only. The first session handed over counts as a change too,
    // "signed out" included: nothing should reach the cache between the
    // removal at mount (above) and that session, since every query waits for
    // a user, and anything that did would be of no known account. Queries
    // only, not mutations: a mutation still in the cache is the previous
    // account's edit, waiting for the network, and still runs. The kept
    // receipt URLs go with the cache: a signed URL is a bearer token (#23),
    // and a sign-in straight over another account is no SIGNED_OUT.
    let shownFor: string | null | undefined;
    const publish = (s: Session | null) => {
      const userId = s?.user?.id ?? null;
      if (userId !== shownFor) {
        queryClient.removeQueries();
        forgetReceiptUrls();
      }
      shownFor = userId;
      setSession(s);
    };

    supabase.auth.getSession().then(({ data: { session: s } }) => {
      publish(s);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, s) => {
      if (__DEV__) {
        console.log('[auth]', event, s?.user?.id ?? null);
      }
      // A signed receipt URL is a bearer token (#23). A change of account
      // (publish, above) drops every one lib/receiptStorage.ts keeps for
      // reuse, sign-out included, and a signing still out then keeps none, so
      // it hands none of them out again. TanStack's cache holds the one a
      // screen was given until the account changes, and under a key that
      // carries its account (lib/hooks/useReceiptUrl.ts), so it is never
      // handed to another account.
      publish(s);
    });

    return () => subscription.unsubscribe();
  }, [queryClient]);

  // describeRequestError, not error.message: sign-in and sign-up POST to
  // /auth/v1/token and /auth/v1/signup, and the first of those is bounded by the
  // 30 s deadline in lib/supabase.ts — so a dead connection returns an
  // AuthRetryableFetchError whose message is "Auth token request aborted after
  // 30000ms", which app/(auth)/sign-in.tsx renders verbatim under the form. The
  // mapper rewrites only abort/timeout-shaped errors, a request that never
  // reached a server (#66), and the auth server's 502/503/504, whose message
  // auth-js leaves as "{}" (#95), so "Invalid login credentials" and every other
  // real auth message still reach the user intact.
  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return { error: error ? new Error(describeRequestError(error)) : null };
  };

  const signUp = async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({ email, password });
    return { error: error ? new Error(describeRequestError(error)) : null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        loading,
        signIn,
        signUp,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
