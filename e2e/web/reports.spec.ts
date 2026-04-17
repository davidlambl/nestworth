import { test, expect } from '@playwright/test';

test.describe('Reports', () => {
  test('displays reports page with period selector and summary cards', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.getByTestId('reports-income-card')).toBeVisible({ timeout: 15000 });

    await expect(page.getByText('1M')).toBeVisible();
    await expect(page.getByText('3M')).toBeVisible();
    await expect(page.getByText('6M')).toBeVisible();
    await expect(page.getByText('1Y')).toBeVisible();

    await expect(page.getByText('Income')).toBeVisible();
    await expect(page.getByText('Expense')).toBeVisible();
    await expect(page.getByText('Net')).toBeVisible();

    await page.getByText('3M').click();
    await expect(page.getByTestId('reports-income-card')).toBeVisible();
  });
});
