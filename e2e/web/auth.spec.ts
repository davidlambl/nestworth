import { test, expect } from '@playwright/test';

test.describe('Auth navigation', () => {
  test('can navigate from sign-in to sign-up', async ({ page }) => {
    await page.goto('/');

    await page.getByTestId('go-to-sign-up').click();

    await expect(page.getByText('Create Account')).toBeVisible();
    await expect(page.getByTestId('sign-up-email')).toBeVisible();
    await expect(page.getByTestId('sign-up-password')).toBeVisible();
    await expect(page.getByTestId('sign-up-confirm-password')).toBeVisible();
    await expect(page.getByTestId('sign-up-submit')).toBeVisible();
  });

  test('can navigate from sign-up back to sign-in', async ({ page }) => {
    await page.goto('/');

    await page.getByTestId('go-to-sign-up').click();
    await expect(page.getByText('Create Account')).toBeVisible();

    await page.getByTestId('go-to-sign-in').click();

    // Expo Router Stack pushes a new sign-in screen rather than popping,
    // so the original sign-in is still in the DOM. Target the topmost one.
    await expect(page.getByTestId('sign-in-submit').last()).toBeVisible();
    await expect(page.getByTestId('sign-in-email').last()).toBeVisible();
  });

  test('sign-in shows validation error on empty submit', async ({ page }) => {
    await page.goto('/');

    await page.getByTestId('sign-in-submit').click();

    await expect(
      page.getByText('Please enter your email and password.')
    ).toBeVisible();
  });
});
