import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // ORCA-35: make-fixture.test.ts runs the fixture generator mid-suite.
    // `domain.test.ts` and `url-state.test.ts` both read `fixtures/config` from
    // their own top level, so a run interleaved with the generator (the default
    // with fileParallelism on, since vitest schedules different test files in
    // parallel workers) could observe a half-emptied directory. The suite is
    // two files and takes seconds; running them one at a time removes the race
    // rather than merely making it rare.
    fileParallelism: false,
  },
});
