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

  await page.getByRole('tab', { name: 'Printer' }).click();
  // Picking a printer is the whole interaction; before that the view should say so
  // rather than render two empty lists.
  await expect(page.getByText('Pick a printer.')).toBeVisible();
  await page.getByLabel('Printer', { exact: true }).selectOption({ label: 'Workshop Cube · user' });
  await expect(page.getByRole('heading', { name: /Filaments/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/7-printer.png`, fullPage: true });
  // `undetermined` has to be its own state on screen, not a boolean with a caveat.
  await expect(page.locator('.compat-row.undetermined').first()).toBeVisible();
  await expect(page.locator('.compat-row.excluded').first()).toBeVisible();
  await expect(page.locator('.compat-row.available').first()).toBeVisible();
  // The two answers nobody would guess, and the reason this view exists: a
  // condition we will not pretend to have evaluated, and a filament available only
  // because the printer inherits from a preset it names.
  await page.getByRole('button', { name: 'undetermined', exact: true }).click();
  await page.screenshot({ path: `${SHOTS}/8-printer-undetermined.png` });
  await expect(page.locator('.compat-expr').first()).toBeVisible();
  await page.getByRole('button', { name: 'all', exact: true }).click();
  // The sentence that stops a bug report being filed: available *because the
  // printer inherits from* a preset the filament names.
  await expect(page.getByText(/which Workshop Cube inherits from/).first()).toBeVisible();

  // A row opens the preset it names.
  await page.locator('.compat-row').first().click();
  await expect(page.locator('main h2').first()).toBeVisible();

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

test('a link carries the view, and Back undoes the tab rather than every chip', async ({ page }) => {
  // A link into a tab with a filter already set. The config loads *after* the URL
  // is read — on its own, in container mode — so loading must not throw the link
  // away, which is the trap this asserts.
  await page.goto('/?tab=health&health=duplicate-name');
  await page.getByRole('button', { name: 'Load sample config' }).click();
  // Not "Config loaded" — that heading is the Presets overview, and landing there
  // is exactly what the link asked us not to do.
  await expect(page.locator('.finding').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('tab', { name: 'Health' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: /^Files never loaded/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Pressed is not the same as applied. Counted against the "All" chip rather than
  // hardcoded, so this stays honest when the generator grows a shape.
  const all = page.getByRole('button', { name: /^All \d+/ });
  const total = Number(/\d+/.exec((await all.textContent()) ?? '')?.[0]);
  const shown = await page.locator('.finding').count();
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(total);

  // Changing tab pushes a history entry. The health filter rides along, because
  // leaving a tab is not the same as resetting it.
  await page.getByRole('tab', { name: 'Presets' }).click();
  await expect(page).toHaveURL(/health=duplicate-name/);
  await expect(page).not.toHaveURL(/tab=/);

  // Typing in the sidebar writes to the URL…
  await page.getByPlaceholder('Search presets…').fill('Fast Draft');
  await expect(page).toHaveURL(/q=Fast\+Draft/);
  // …and clicking a chip replaces rather than pushes, so one Back returns to the
  // tab we came from instead of unwinding six chip clicks.
  await page.getByRole('button', { name: /^system/ }).click();
  await expect(page).toHaveURL(/origins=user%2Csystem/);
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Health' })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/tab=health/);
});
