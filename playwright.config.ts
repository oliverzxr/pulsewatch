import { defineConfig } from '@playwright/test';

const url = 'http://127.0.0.1:3301';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  use: {
    baseURL: url,
    channel: process.env.PLAYWRIGHT_CHANNEL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [{
    command: 'npm start',
    url: `${url}/api/health`,
    env: { PORT: '3301', DATABASE_PATH: ':memory:', CHECK_INTERVAL_MS: '300000' },
    timeout: 20000,
  }, {
    command: 'npm run preview:demo -- --port 4174',
    url: 'http://127.0.0.1:4174/',
    timeout: 20000,
  }],
});
