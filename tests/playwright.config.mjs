import {defineConfig, devices} from '@playwright/test';
import {server} from './lib/jellyfin.mjs';

// These specs drive real input and real playback, and run everywhere. The rest test the server or use Chromium's
// debugger, so one browser says all they have to say.
const everyBrowser = /(playback|popup|hover|touch|keys|hostile|settings|native-subtitles)\.spec\.mjs$/;

// WebKit's libraries are not on this machine's system path, and scripts/webkit-deps.sh puts them where it looks.
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS ??= '1';

export default defineConfig({
    testDir: 'e2e',
    outputDir: `test-results/${server.name}`,
    fullyParallel: false,
    workers: 1,
    forbidOnly: true,
    timeout: 60_000,
    reporter: [['list']],
    use: {
        baseURL: `${server.url}/`,
        trace: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                launchOptions: {args: ['--autoplay-policy=no-user-gesture-required']},
            },
        },
        {
            name: 'firefox',
            testMatch: everyBrowser,
            use: {
                ...devices['Desktop Firefox'],
                launchOptions: {firefoxUserPrefs: {'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0}},
            },
        },
        {
            name: 'webkit',
            testMatch: everyBrowser,
            // Headless WPE sometimes dies between tests, before a test has started. A retry shows up as flaky in the results.
            retries: 1,
            use: {...devices['Desktop Safari']},
        },
        {
            // Touch, a phone's viewport and its user agent, on desktop Chromium. It is not a phone.
            name: 'android-chrome',
            testMatch: everyBrowser,
            use: {
                ...devices['Pixel 7'],
                launchOptions: {args: ['--autoplay-policy=no-user-gesture-required']},
            },
        },
    ],
});
