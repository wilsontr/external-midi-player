import { defineConfig } from '@playwright/test';

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
    {
      name: 'firefox',
      use: {
        browserName: 'firefox',
        // Playwright's Firefox build cannot initialize its macOS seatbelt
        // sandbox when the browser itself runs inside a nested file sandbox
        // (some developer/CI sandboxes); it crashes on the first page. Content
        // sandboxing is irrelevant for these mocked, localhost-only tests.
        launchOptions: { env: { MOZ_DISABLE_CONTENT_SANDBOX: '1' } },
      },
    },
  ],
  webServer: {
    command: 'npm run dev -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
