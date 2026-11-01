// The `test` every spec that plays video imports. It fails a test on any uncaught error in the page, because the
// failure paths of Phase 3 passed every test while throwing on each timeupdate, and only a recording of page errors
// showed it. Everything counts unless it is listed in IGNORED_PAGE_ERRORS, which says why.
import {test as base} from '@playwright/test';

export {expect} from '@playwright/test';

/**
 * Errors from jellyfin-web that have nothing to do with the plugin, and that a test cannot avoid. The plugin's own
 * bundles are never excused: see `isOurs`. Each entry is logged when it is used, so nothing here disappears silently.
 * @type {{pattern: RegExp, why: string}[]}
 */
export const IGNORED_PAGE_ERRORS = [
    {
        pattern: /ReferenceError: e is not defined[\s\S]*blob:/,
        why: 'JASSUB\'s worker in Firefox, jellyfin-web\'s ASS renderer. It happens with the plugin blocked, and it still draws',
    },
    {
        pattern: /Can't find variable: e\b/,
        why: 'the same workers in WebKit, for JASSUB and for image subtitles. It happens with the plugin blocked',
    },
    {
        pattern: /can't access property "length", t is undefined/,
        why: 'jellyfin-web\'s home screen in Firefox, when a reload cuts off its requests. No frame of the plugin\'s is involved',
    },
    {
        pattern: /XMLHttpRequest cannot load [\s\S]*node_modules\.axios\.bundle/,
        why: 'jellyfin-web\'s home screen in WebKit, whose requests are cut off when a test goes straight to the player',
    },
    {
        pattern: /t\.scrollHandler is not a function/,
        why: 'jellyfin-web\'s page scroller in WebKit, when a test moves on from the home screen. No video has played, so the engine is not loaded',
    },
    {
        pattern: /ActionSheet closed without resolving/,
        why: 'jellyfin-web\'s menus reject a promise nobody handles when they close with no choice made. It is the same with the plugin off',
    },
    {
        pattern: /Loading chunk \d+ failed/,
        why: 'jellyfin-web lazily loading a card script for the home screen while the page moves on to the player',
    },
];

function isOurs(text) {
    return /\/Yomitan\/(engine|client)\.js/.test(text);
}

function describeError(error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ''}`;
}

// Chromium reports a rejection nobody handled as a page error, and the other engines do not all do so.
const reportRejections = () => {
    window.addEventListener('unhandledrejection', ({reason}) => {
        console.error(`[test] unhandled rejection: ${reason?.message ?? ''}\n${reason?.stack ?? reason}`);
    });
};

export const test = base.extend({
    pageErrors: [async ({context}, use, testInfo) => {
        const errors = [];
        const record = (text) => {
            const ignored = isOurs(text) ? undefined : IGNORED_PAGE_ERRORS.find(({pattern}) => pattern.test(text));
            if (ignored) {
                console.log(`[page error excused: ${ignored.why}] ${text.split('\n')[0]}`);
            } else {
                errors.push(text);
            }
        };

        await context.addInitScript(reportRejections);
        context.on('weberror', (webError) => record(describeError(webError.error())));
        context.on('console', (message) => {
            if (message.text().startsWith('[test] unhandled rejection')) {
                record(message.text());
            }
        });

        await use(errors);
        // A test that expects errors reads and empties this list.
        if (errors.length > 0 && testInfo.status === testInfo.expectedStatus) {
            throw new Error(`Uncaught errors in the page:\n${errors.join('\n\n')}`);
        }
    }, {auto: true}],
});
