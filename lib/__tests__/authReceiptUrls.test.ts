// A signed receipt URL is a bearer token for one photo; lib/receiptStorage.ts
// hands none out again once the session it was signed in has ended (#23). The
// AuthProvider drops every kept URL on SIGNED_OUT (a signing still out then
// keeps none: receiptStorage.test.ts). Recipe from authErrors.test.ts:
// react-test-renderer and createElement, no JSX.
jest.mock('../supabase', () => {
  let signed = 0;
  const bucket = {
    createSignedUrl: jest.fn(async (path: string) => {
      signed += 1;
      return {
        data: {
          signedUrl: `https://x.supabase.co/sign/${path}?token=t${signed}`,
        },
        error: null,
      };
    }),
  };
  return {
    supabase: {
      auth: {
        getSession: jest.fn(async () => ({
          data: { session: { access_token: 'a', user: { id: 'u' } } },
        })),
        onAuthStateChange: jest.fn(() => ({
          data: { subscription: { unsubscribe: jest.fn() } },
        })),
      },
      storage: { from: jest.fn(() => bucket) },
    },
  };
});

import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { supabase } from '../supabase';
import { AuthProvider } from '../auth';
import { forgetReceiptUrls, receiptUrl } from '../receiptStorage';

const onAuthStateChange = supabase.auth
  .onAuthStateChange as unknown as jest.Mock;
let renderer: ReactTestRenderer;

beforeEach(async () => {
  forgetReceiptUrls();
  await act(async () => {
    renderer = TestRenderer.create(createElement(AuthProvider, null));
  });
});

afterEach(() => {
  act(() => {
    renderer.unmount();
  });
});

it('signing out drops every kept receipt URL (mutant: kept across the sign-out)', async () => {
  const before = await receiptUrl('u', 'u/t1.n1.jpg');
  expect(await receiptUrl('u', 'u/t1.n1.jpg')).toBe(before);

  const listener = onAuthStateChange.mock.calls[0][0];
  await act(async () => {
    listener('SIGNED_OUT', null);
  });

  // Signed in again: the photo is signed afresh, never the old URL.
  expect(await receiptUrl('u', 'u/t1.n1.jpg')).not.toBe(before);
});
