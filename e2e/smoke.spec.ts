import { test, expect } from '@playwright/test';
const SHOTS = process.env.ORCA_SHOTS ?? 'e2e/screenshots';

test('loads a config and walks every tab without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  /**
   * In static mode the app probes `api/health` to find out whether a config
   * server is behind this origin, and there is not one — so Chromium logs a 404
   * for it before anything is even clicked. That is the fallback working, not a
   * fault, and it is the only 404 tolerated: any other missing resource is
   * exactly what this test is for.
   */
  const missing: string[] = [];
  page.on('response', r => { if (r.status() === 404) missing.push(new URL(r.url()).pathname); });
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource.*404/.test(m.text())) return;
    errors.push(m.text());
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Load sample config' }).click();
  await expect(page.getByText('Config loaded')).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/1-overview.png` });

  await page.getByRole('tab', { name: 'Health' }).click();
  await expect(page.locator('.finding').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/4-health.png` });

  await page.getByRole('tab', { name: 'Presets' }).click();
  // A name the generated fixture actually has, and the one this screenshot is
  // named after: `Fast Draft` is the detached full copy, claimed by two files.
  await page.getByPlaceholder('Search presets…').fill('Fast Draft');
  await page.locator('.row').first().click();
  await page.screenshot({ path: `${SHOTS}/2-detached.png`, fullPage: true });

  console.log('PAGE_ERRORS:' + JSON.stringify(errors));
  expect(errors).toEqual([]);
  expect([...new Set(missing)]).toEqual(['/api/health']);
});
