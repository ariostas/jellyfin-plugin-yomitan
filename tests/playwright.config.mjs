import {defineConfig, devices} from '@playwright/test';
import {server} from './lib/jellyfin.mjs';

// These specs drive real input and real playback, and run everywhere. The rest test the server or use Chromium's
// debugger, so one browser says all they have to say.
const everyBrowser = /(playback|popup|hover|touch|keys|hostile|settings|native-subtitles|player-toggle|user-page|admin-page)\.spec\.mjs$/;

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
            // Headless WPE sometimes dies between tests, or while opening a tab, with or without the plugin: about one
            // launch in ten. With one retry, a matrix run of hundreds of tests still lost both attempts of one now and
            // then. A retry shows up as flaky in the results.
            retries: 2,
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
