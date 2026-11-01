// The setting store, and the exit condition of Phase 4: with `enabled` off, playback is what it is without the plugin.
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {createUser, credentials, defaultSettings, deleteUser, getMovies, logIn, play, readSettings, server} from '../lib/jellyfin.mjs';
import {expectPopup, isPaused, LINES, moveToWord, parkMouse, popupState, showLine, startLookupFilm} from '../lib/lookup.mjs';
import {makeMiniDictionary} from '../lib/mini-dictionary.mjs';
import {countListeners, engineTimers, jellyfinLine, trackEngineTimers} from '../lib/player.mjs';
import {expect, test} from '../lib/test.mjs';

test.describe.configure({timeout: 120_000});

let admin;
let movies;

test.beforeAll(async () => {
    admin = await clientFor(credentials.username, credentials.password);
    await deleteAll(admin);
    expect((await importArchive(admin, makeMiniDictionary())).state).toBe('succeeded');
    movies = await getMovies();
});

test.afterAll(async () => {
    await deleteAll(admin);
});

/**
 * Records every listener the plugin's own code adds to the page, in every browser, by what called addEventListener. The
 * rest of the stack can hold the loader's wrapper around Events.trigger, under listeners that are jellyfin-web's.
 */
const trackOurListeners = (page) => page.addInitScript(() => {
    window.ourListeners = [];
    const {addEventListener} = EventTarget.prototype;
    EventTarget.prototype.addEventListener = function (type, ...rest) {
        const [, caller] = new Error('where').stack.split('\n').filter((frame) => !frame.startsWith('Error'));
        if ((this instanceof Node || this instanceof Window) && /\/Yomitan\//.test(caller)) {
            window.ourListeners.push(`${this.constructor.name} ${type}`);
        }

        return addEventListener.call(this, type, ...rest);
    };
});

const ownElements = (page) => page.evaluate(() => ({
    elements: document.querySelectorAll('[class*=yomitan], [id*=yomitan]').length,
    attribute: document.documentElement.hasAttribute('data-yomitan-hides-subtitles'),
}));

test('a new user has the defaults, through the one store the page has', async ({page}) => {
    const user = await createUser('new');
    await logIn(page, {user, settings: null});
    await expect.poll(() => page.evaluate(() => window.__yomitanJellyfin.settings.userId)).toBe(user.id);
    const values = await page.evaluate(() => {
        const {settings} = window.__yomitanJellyfin;
        return Object.fromEntries(['enabled', 'hoverDelayMs', 'hoverGraceMs', 'upOnlyEntry', 'fontScale', 'dictionaryOrder', 'disabledDictionaries'].map((name) => [name, settings.get(name)]));
    });
    expect(values).toEqual(await readSettings(user));
    expect(values).toEqual(defaultSettings);
    await deleteUser(user);
});

test('a value survives a reload, and the store refuses the wrong type', async ({page}) => {
    await logIn(page);
    await page.evaluate(() => window.__yomitanJellyfin.settings.set('hoverDelayMs', 75));
    await expect.poll(async () => (await readSettings(credentials)).hoverDelayMs).toBe(75);
    await page.reload();
    await page.waitForFunction(() => window.__yomitanJellyfin?.settings.get('hoverDelayMs') === 75);
    expect(await page.evaluate(() => {
        const {settings} = window.__yomitanJellyfin;
        let refused = false;
        try {
            settings.set('enabled', 'no');
        } catch {
            refused = true;
        }

        return [settings.get('hoverDelayMs'), refused, settings.get('enabled')];
    })).toEqual([75, true, true]);
});

test('the hover delay comes from the store, while playing', async ({page, isMobile}) => {
    test.skip(isMobile, 'A finger does not hover.');
    await logIn(page);
    await startLookupFilm(page);
    await parkMouse(page);
    await showLine(page, LINES.plain);
    // Long enough that a busy machine's slow mouse cannot run out the delay before the check.
    await page.evaluate(() => window.__yomitanJellyfin.settings.set('hoverDelayMs', 3000));
    await moveToWord(page, '学校');
    await page.waitForTimeout(700);
    expect((await popupState(page)).open).toBe(false);
    expect(await isPaused(page)).toBe(false);
    await expectPopup(page, '学校');
});

test.describe('with enabled off', () => {
    test('nothing of the plugin is on the page, the video or the network', async ({page}) => {
        const requests = [];
        page.on('request', (request) => {
            if (/\/Yomitan\/(?!client\.js|Settings)/.test(request.url())) {
                requests.push(request.url());
            }
        });
        await trackOurListeners(page);
        await logIn(page, {settings: {enabled: false}});
        await play(page, movies.TracksSample, {subtitleStreamIndex: 2, minimumTime: 3});
        await page.waitForTimeout(1500);

        expect(requests).toEqual([]);
        expect(await ownElements(page)).toEqual({elements: 0, attribute: false});
        // What the loader itself needs, and the toggle's button, and nothing on the video or the document.
        expect((await page.evaluate(() => window.ourListeners)).sort()).toEqual(['HTMLButtonElement click', 'Window viewshow', 'Window visibilitychange']);
        expect(await page.evaluate(() => window.__yomitanJellyfin.playback)).toBeUndefined();
        expect(await jellyfinLine(page)).toBe('showing');
        expect(await isPaused(page)).toBe(false);
    });

    test('the video has exactly the listeners it has with the plugin blocked', async ({page, browser, browserName}) => {
        test.skip(browserName !== 'chromium', 'Counting listeners takes Chromium\'s debugger.');
        const listeners = async (target) => {
            await logIn(target, {settings: {enabled: false}});
            await play(target, movies.TracksSample, {subtitleStreamIndex: 2, minimumTime: 2});
            await target.waitForTimeout(1000);
            return {
                video: await countListeners(target, 'document.querySelector("video.htmlvideoplayer")'),
                document: await countListeners(target, 'document'),
                tracks: await target.evaluate(() => [...document.querySelector('video.htmlvideoplayer').textTracks].map(({mode}) => mode)),
            };
        };

        await page.route('**/Yomitan/client.js*', (route) => route.abort());
        const without = await listeners(page);

        const context = await browser.newContext({baseURL: `${server.url}/`});
        const disabled = await context.newPage();
        const off = await listeners(disabled);
        await context.close();
        console.log('listeners with the plugin blocked and with it disabled:', without, off);
        expect(off).toEqual(without);
    });

    test('a Japanese track with an installed dictionary stays Jellyfin\'s, through a whole line', async ({page}) => {
        await logIn(page, {settings: {enabled: false}});
        const {LookupSample: item} = await getMovies();
        await play(page, item, {subtitleStreamIndex: 0, minimumTime: 1});
        await expect.poll(() => page.evaluate(() => {
            const inner = document.querySelector('.videoSubtitlesInner');
            const cue = document.querySelector('video.htmlvideoplayer').textTracks[0]?.activeCues?.[0];
            return inner?.textContent ?? cue?.text ?? '';
        })).toContain('昨日');
        expect(await jellyfinLine(page)).toBe('showing');
        expect(await ownElements(page)).toEqual({elements: 0, attribute: false});
    });
});

test.describe('turning it off and on while playing', () => {
    test('off puts everything back and takes its timers and listeners with it', async ({page, browserName}) => {
        await trackEngineTimers(page);
        await logIn(page);
        await startLookupFilm(page);
        await showLine(page, LINES.plain);
        expect((await ownElements(page)).attribute).toBe(true);
        const video = 'document.querySelector("video.htmlvideoplayer")';
        const during = browserName === 'chromium' ? await countListeners(page, video) : 0;

        await page.evaluate(() => window.__yomitanJellyfin.settings.set('enabled', false));
        await expect.poll(() => ownElements(page)).toEqual({elements: expect.any(Number), attribute: false});
        expect(await jellyfinLine(page)).toBe('showing');
        expect((await engineTimers(page)).intervals).toBe(0);
        expect(await page.locator('.yomitan-layer').count()).toBe(0);
        if (browserName === 'chromium') {
            expect(await countListeners(page, video)).toBeLessThan(during);
        }

        await page.evaluate(() => window.__yomitanJellyfin.settings.set('enabled', true));
        await page.waitForFunction(() => window.__yomitanJellyfin.playback.session?.state === 'active');
        await expect.poll(() => ownElements(page)).toEqual({elements: expect.any(Number), attribute: true});
    });

    test('off with the video paused for a lookup resumes it', async ({page, isMobile}) => {
        test.skip(isMobile, 'The mouse is the short way to the same state.');
        await logIn(page);
        await startLookupFilm(page);
        await parkMouse(page);
        await showLine(page, LINES.plain);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await page.evaluate(() => window.__yomitanJellyfin.settings.set('enabled', false));
        await expect.poll(() => isPaused(page)).toBe(false);
        expect(await page.locator('.yomitan-popup').count()).toBe(0);
    });

    test('a session that starts disabled starts when turned on', async ({page}) => {
        await logIn(page, {settings: {enabled: false}});
        await play(page, movies.TracksSample, {subtitleStreamIndex: 2, minimumTime: 1});
        expect(await page.evaluate(() => window.__yomitanJellyfin.playback)).toBeUndefined();
        await page.evaluate(() => window.__yomitanJellyfin.settings.set('enabled', true));
        await page.waitForFunction(() => window.__yomitanJellyfin.playback?.session?.state === 'active');
    });
});
