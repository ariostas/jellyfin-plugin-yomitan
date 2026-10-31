import {defineConfig, devices} from '@playwright/test';
import {server} from './lib/jellyfin.mjs';

export default defineConfig({
    testDir: 'e2e',
    outputDir: `test-results/${server.name}`,
    fullyParallel: false,
    workers: 1,
    forbidOnly: true,
    timeout: 60_000,
    reporter: [['list']],
    use: {
        ...devices['Desktop Chrome'],
        baseURL: `${server.url}/`,
        trace: 'retain-on-failure',
        launchOptions: {args: ['--autoplay-policy=no-user-gesture-required']},
    },
});
