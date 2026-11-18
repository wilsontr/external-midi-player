import { defineConfig } from '@playwright/test';

// Playwright's Firefox build cannot initialise its macOS seatbelt sandbox when
// the browser itself runs inside a nested file sandbox (this project's
// developer sandbox). Set the flag in the inherited environment rather than in
// `launchOptions.env`, which would *replace* the browser's whole environment.
// Content sandboxing is irrelevant for these mocked, localhost-only tests.
declare const process: { env: Record<string, string | undefined> };
process.env.MOZ_DISABLE_CONTENT_SANDBOX = '1';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
  webServer: {
    command: 'npm run dev -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
