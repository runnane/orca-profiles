import { test, expect } from '@playwright/test';
const SHOTS = process.env.ORCA_SHOTS ?? 'e2e/screenshots';

test('loads a config and walks every tab without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource.*404/.test(m.text())) errors.push(m.text()); });

  await page.goto('/');
  await page.getByRole('button', { name: 'Load sample config' }).click();
  await expect(page.getByText('Config loaded')).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/1-overview.png` });

  await page.getByRole('tab', { name: 'Health' }).click();
  await expect(page.locator('.finding').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/4-health.png` });

  await page.getByRole('tab', { name: 'Graph' }).click();
  // The graph is navigation, not a picture: a node has to be reachable by keyboard
  // and opening one has to land in the preset it names.
  await expect(page.getByRole('tree', { name: 'Inheritance forest' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/5-graph.png`, fullPage: true });
  await page.getByRole('treeitem').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/6-graph-bottom.png` });
  const firstNode = page.getByRole('treeitem').first();
  await firstNode.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('main h2').first()).toBeVisible();

  await page.getByRole('tab', { name: 'Presets' }).click();
  await page.getByPlaceholder('Search presets…').fill('Fast Draft');
  await page.locator('.row').first().click();
  await page.screenshot({ path: `${SHOTS}/2-detached.png`, fullPage: true });

  console.log('PAGE_ERRORS:' + JSON.stringify(errors));
  expect(errors).toEqual([]);
});
