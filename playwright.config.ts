import fs from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const systemChromiumPath = '/usr/bin/chromium';
const useSystemChromium = fs.existsSync(systemChromiumPath);

export default defineConfig({
  testDir: './tests/specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(useSystemChromium
          ? {
              launchOptions: {
                executablePath: systemChromiumPath,
                args: ['--no-sandbox', '--disable-dev-shm-usage'],
              },
            }
          : {}),
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
