import { test, expect } from '@playwright/test';

test.describe('Smoke', () => {
  test('app loads and shows sign-in form', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('sign-in-email')).toBeVisible();
    await expect(page.getByTestId('sign-in-password')).toBeVisible();
    await expect(page.getByTestId('sign-in-submit')).toBeVisible();
  });

  test('sign-in page has correct heading', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('Nestworth')).toBeVisible();
    await expect(page.getByText('Sign in to your account')).toBeVisible();
  });
});
