import { test, expect } from '@playwright/test';
const SHOTS = process.env.ORCA_SHOTS ?? 'e2e/screenshots';

test('loads a config and walks every tab without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  await page.getByRole('button', { name: 'Load sample config' }).click();
  await expect(page.getByText('Config loaded')).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/1-overview.png` });

  await page.getByRole('tab', { name: 'Health' }).click();
  await expect(page.locator('.finding').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/4-health.png` });

  await page.getByRole('tab', { name: 'Presets' }).click();
  await page.getByPlaceholder('Search presets…').fill('ABS fast');
  await page.locator('.row').first().click();
  await page.screenshot({ path: `${SHOTS}/2-detached.png`, fullPage: true });

  console.log('PAGE_ERRORS:' + JSON.stringify(errors));
  expect(errors).toEqual([]);
});
