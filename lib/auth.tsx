import React, { createContext, useContext, useEffect, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { describeRequestError } from './requestError';

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

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, s) => {
      if (__DEV__) {
        console.log('[auth]', event, s?.user?.id ?? null);
      }
      setSession(s);
    });

    return () => subscription.unsubscribe();
  }, []);

  // describeRequestError, not error.message: sign-in and sign-up POST to
  // /auth/v1/token and /auth/v1/signup, and the first of those is bounded by the
  // 30 s deadline in lib/supabase.ts — so a dead connection returns an
  // AuthRetryableFetchError whose message is "Auth token request aborted after
  // 30000ms", which app/(auth)/sign-in.tsx renders verbatim under the form. The
  // mapper rewrites only abort/timeout-shaped errors, so "Invalid login
  // credentials" and every other real auth message still reach the user intact.
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
