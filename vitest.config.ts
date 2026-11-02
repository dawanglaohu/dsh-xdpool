import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/lib/**'],
    environment: 'node',
    // A test that makes the shim refuse a request would otherwise overwrite
    // `$DSH_HOME/.xdpool/last-rejected-body.json` — the one artefact an
    // investigation reads. The tests that exercise the dump set this to some
    // other value themselves.
    env: { XDPOOL_NO_BODY_DUMP: '1' },
  },
})