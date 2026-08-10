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
  // The badges on each row are verdicts; a verdict with no consequence attached is
  // alarming and unactionable at once. The explanation has to be reachable on the
  // page, not only as a tooltip.
  await page.getByText('What these labels mean').click();
  await expect(page.getByText(/Vendor updates never reach it/)).toBeVisible();
  await expect(page.getByText(/being detached is the point of it/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/5-graph.png`, fullPage: true });
  await page.getByRole('treeitem').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/6-graph-bottom.png` });
  // Turning every kind off must not take the controls off screen with the diagram.
  // A notice that blames "these filters" while unmounting the filters is a dead end:
  // the only way out was switching tabs, which worked by accident. The chips have to
  // survive their own effect, and clicking one has to bring the graph back.
  const kindChip = (k: string) => page.getByRole('button', { name: k, exact: true });
  for (const k of ['filament', 'process', 'machine']) await kindChip(k).click();
  await expect(page.getByRole('tree', { name: 'Inheritance forest' })).toBeHidden();
  await expect(page.getByText('No kinds selected.')).toBeVisible();
  await expect(kindChip('filament')).toBeVisible();
  await kindChip('filament').click();
  await expect(page.getByRole('tree', { name: 'Inheritance forest' })).toBeVisible();
  for (const k of ['process', 'machine']) await kindChip(k).click();

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
  // The dropdown's own sections, in its order and its words, so the two lists can
  // be read side by side rather than reconciled row by row.
  await expect(page.locator('.preset-group > summary .pg-title')).toContainText([
    'User presets',
    'System presets',
    'Unsupported presets',
    'Undetermined',
    'Not installed',
  ]);
  // System filaments sit in a vendor submenu, which is what `Generic >` is.
  await expect(page.locator('.preset-group .pg-sub').first()).toContainText('Acme');
  // And a row is labelled with its alias, with the preset's own name beside it.
  await expect(page.getByText('Acme PLA-CF', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/7-printer.png`, fullPage: true });
  // `undetermined` has to be its own state on screen, not a boolean with a caveat.
  await expect(page.locator('.compat-row.undetermined').first()).toBeVisible();
  await expect(page.locator('.compat-row.excluded').first()).toBeVisible();
  await expect(page.locator('.compat-row.available').first()).toBeVisible();
  // The installed gate is a verdict of its own, because its fix is a different
  // one: "add this filament in OrcaSlicer", not "edit `compatible_printers`".
  await page.getByRole('button', { name: 'not installed', exact: true }).click();
  await expect(page.locator('.compat-row.not-installed').first()).toBeVisible();
  await expect(page.getByText(/You have not added this filament/).first()).toBeVisible();
  // And the compatibility answer survives as the answer to "and if I did?".
  await expect(page.getByText(/Once installed/).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/9-printer-not-installed.png`, fullPage: true });
  await page.getByRole('button', { name: 'all', exact: true }).click();
  // The two answers nobody would guess, and the reason this view exists: a
  // condition we will not pretend to have evaluated, and a filament available only
  // because the printer inherits from a preset it names.
  await page.getByRole('button', { name: 'undetermined', exact: true }).click();
  await page.screenshot({ path: `${SHOTS}/8-printer-undetermined.png` });
  await expect(page.locator('.compat-expr').first()).toBeVisible();
  await page.getByRole('button', { name: 'all', exact: true }).click();
  // A gate that arrived through `inherits` has to name the file that states it —
  // most user presets store no `compatible_printers` and are pinned by one anyway.
  await expect(
    page.getByText(/that comes from “Acme ABS @Cube6”, which it inherits/).first(),
  ).toBeVisible();
  // The sentence that stops a bug report being filed: available *because the
  // printer inherits from* a preset the filament names.
  await expect(page.getByText(/which Workshop Cube inherits from/).first()).toBeVisible();

  // A vendor printer whose nozzle the user never installed is not one OrcaSlicer
  // offers, so it is not in the picker's main list — and it is still reachable,
  // grouped and named, because "why is this printer not offered" is a question
  // this app exists to answer.
  const printerPick = page.getByLabel('Printer', { exact: true });
  await expect(printerPick.locator('optgroup')).toHaveAttribute('label', /Not installed/);
  await expect(
    printerPick.locator('optgroup > option', { hasText: 'Acme Cube 0.6 nozzle' }),
  ).toHaveCount(1);
  await printerPick.selectOption({ label: 'Acme Cube 0.6 nozzle · system' });
  await expect(page.getByText('This printer is not installed.')).toBeVisible();
  await printerPick.selectOption({ label: 'Workshop Cube · user' });

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

test('the graph’s filters survive leaving the tab, and the all-off state has a way out', async ({
  page,
}) => {
  // The reason ORCA-15 was sequenced behind ORCA-12. Until URL state landed, `App`
  // unmounted `GraphView` on a tab change and the filter state died with it — which
  // meant leaving the tab and coming back was the *only* escape from an all-off
  // filter set. That escape hatch is gone now, so the on-screen one has to work.
  await page.goto('/?tab=graph&gkinds=machine&gvendor=1');
  await page.getByRole('button', { name: 'Load sample config' }).click();

  const machine = page.getByRole('button', { name: 'machine', exact: true });
  await expect(machine).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 });
  await expect(page.getByRole('button', { name: 'filament', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByRole('button', { name: /include vendor-only subtrees/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Leave and come back: the filters are still there, which is the whole point and
  // was not true before.
  await page.getByRole('tab', { name: 'Presets' }).click();
  await page.getByRole('tab', { name: 'Graph' }).click();
  await expect(machine).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/gkinds=machine/);

  // Turning the last kind off empties the diagram. The chips stay on screen and the
  // notice offers the way back — without which this state is now a dead end.
  await machine.click();
  await expect(page).toHaveURL(/gkinds=(?:&|$)/);
  await expect(page.getByText('No kinds selected.')).toBeVisible();
  await expect(machine).toBeVisible();

  // And it survives the unmount too, so the notice is the only exit.
  await page.getByRole('tab', { name: 'Presets' }).click();
  await page.getByRole('tab', { name: 'Graph' }).click();
  await expect(page.getByText('No kinds selected.')).toBeVisible();

  await page.getByRole('button', { name: 'Show all three kinds' }).click();
  await expect(machine).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.graph-node').first()).toBeVisible();

  // Chips replace rather than push: one Back leaves the graph rather than unwinding
  // the four clicks above.
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Presets' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
