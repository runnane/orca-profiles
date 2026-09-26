/**
 * `scripts/make-fixture.mjs` used to `rmSync` the whole `fixtures/config`
 * directory before regenerating it — ORCA-35: a container bind-mounted on
 * that directory (`-v $PWD/fixtures/config:/config:ro`, the way
 * `.agents/gates.md`'s fixture-backed `test:server` recipe runs it) is left
 * pointing at a deleted inode, and sees an empty `/config` forever after,
 * however many times the fixture is regenerated afterwards.
 *
 * So the directory itself must survive a regeneration and only its *contents*
 * may be removed. Checked two ways: the inode is unchanged, and a stray file
 * planted in the directory before the run is gone afterwards — so "contents
 * emptied" is asserted too, not just "directory kept", which a mutation that
 * stopped emptying anything (but also stopped removing the directory) would
 * otherwise sail through.
 *
 * Running the generator here, mid-suite, is what `fileParallelism: false` in
 * `vitest.config.ts` is for: `domain.test.ts` and `url-state.test.ts` both
 * read `fixtures/config` from their own top level, and with files running in
 * parallel workers (the default) a read could land mid-regeneration.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../fixtures/config', import.meta.url).pathname;
const GENERATOR = new URL('../../scripts/make-fixture.mjs', import.meta.url).pathname;

describe('the fixture generator', () => {
  it("keeps fixtures/config's own inode, and empties its contents", () => {
    mkdirSync(ROOT, { recursive: true });
    const inodeBefore = statSync(ROOT).ino;

    const stray = join(ROOT, 'stray-leftover-file.json');
    writeFileSync(stray, '{}');

    execFileSync(process.execPath, [GENERATOR]);

    expect(statSync(ROOT).ino).toBe(inodeBefore);
    expect(existsSync(stray)).toBe(false);
  });
});
