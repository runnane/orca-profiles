import { test, expect } from '@playwright/test';

/**
 * Points at a running container (`pnpm docker:run`), not the static preview, so
 * it exercises the path that has no folder picker at all. Override the target
 * with ORCA_URL to test a remote one through a tunnel.
 */
test('server mode auto-loads with no picker', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(process.env.ORCA_URL ?? 'http://localhost:8099/');
  // No click on "Choose folder" anywhere: it should load by itself.
  await expect(page.getByText('Config loaded')).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: 'e2e/screenshots/server.png' });

  await page.getByRole('tab', { name: 'Health' }).click();
  await expect(page.locator('.finding').first()).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/server-health.png' });

  console.log('PAGE_ERRORS:' + JSON.stringify(errors));
  expect(errors).toEqual([]);
});
