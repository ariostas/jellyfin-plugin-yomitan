// The button in the OSD. The feature is off by default, so this is where people meet it.
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {credentials, getMovies, logIn, play, readSettings} from '../lib/jellyfin.mjs';
import {expectCursor, inWordMode, useTvLayout} from '../lib/keys.mjs';
import {isPaused, LINES, osdShowing, parkMouse, showLine} from '../lib/lookup.mjs';
import {makeMiniDictionary} from '../lib/mini-dictionary.mjs';
import {jellyfinLine, overlayText, setSubtitleTrack, stopPlayback} from '../lib/player.mjs';
import {expect, test} from '../lib/test.mjs';

test.describe.configure({timeout: 120_000});

/** As in playback.spec.mjs: external subtitles of TracksSample, in the order the server sorts them. */
const TRACKS = {english: 0, chinese: 1, japanese: 2, untagged: 3};
const BUTTON = '.btnYomitan';

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

/** Shows the OSD, with whatever input this project has. */
async function showOsd(page, isMobile) {
    if (await osdShowing(page)) {
        return;
    }

    if (isMobile) {
        await page.touchscreen.tap(200, 200);
    } else {
        await page.mouse.move(100, 180);
        await page.mouse.move(120, 200, {steps: 2});
    }

    await expect.poll(() => osdShowing(page)).toBe(true);
}

/** Presses the button with this project's input, showing the OSD first if it has gone. */
async function press(page, isMobile) {
    await showOsd(page, isMobile);
    const button = page.locator(BUTTON);
    await (isMobile ? button.tap() : button.click());
}

const pressed = (page) => page.locator(BUTTON).getAttribute('aria-pressed');

const startOff = async (page) => {
    await logIn(page, {settings: {enabled: false}});
    await play(page, movies.LookupSample, {subtitleStreamIndex: 0, minimumTime: 0.5});
    await page.locator(BUTTON).waitFor({state: 'attached'});
};

test('it turns the feature on and off at once, without touching the video, and it stays', {tag: '@smoke'}, async ({page, isMobile}) => {
    await startOff(page);
    await page.evaluate(() => {
        window.theVideo = document.querySelector('video.htmlvideoplayer');
        window.theSource = window.theVideo.src;
    });
    expect(await pressed(page)).toBe('false');
    expect(await jellyfinLine(page)).toBe('showing');
    expect(await page.locator('.yomitan-overlay').count()).toBe(0);

    await press(page, isMobile);
    await page.waitForFunction(() => window.__yomitanJellyfin.playback?.session?.state === 'active');
    expect(await pressed(page)).toBe('true');
    await expect.poll(() => jellyfinLine(page)).toBe('hidden');
    await showLine(page, LINES.plain);
    expect(await overlayText(page)).toContain('昨日');
    await expect.poll(async () => (await readSettings(credentials)).enabled).toBe(true);

    await press(page, isMobile);
    await expect.poll(() => page.locator('.yomitan-overlay').count()).toBe(0);
    await expect.poll(() => jellyfinLine(page)).toBe('showing');
    expect(await pressed(page)).toBe('false');
    await expect.poll(async () => (await readSettings(credentials)).enabled).toBe(false);

    await press(page, isMobile);
    await page.waitForFunction(() => window.__yomitanJellyfin.playback?.session?.state === 'active');

    // Through all of that it was the same video, still playing.
    expect(await page.evaluate(() => {
        const video = document.querySelector('video.htmlvideoplayer');
        return {same: video === window.theVideo && video.src === window.theSource, paused: video.paused};
    })).toEqual({same: true, paused: false});
});

test.describe('it is only there when it can do something', () => {
    test('a track at a time', async ({page}) => {
        await logIn(page, {settings: {enabled: false}});
        await play(page, movies.TracksSample, {subtitleStreamIndex: TRACKS.japanese, minimumTime: 0.5});
        const button = page.locator(BUTTON);
        await expect(button).toHaveCount(1);

        // Tagged in another language, no subtitles, and text whose tag says nothing, either way.
        await setSubtitleTrack(page, TRACKS.english);
        await expect(button).toHaveCount(0);
        await setSubtitleTrack(page, -1);
        await page.waitForTimeout(800);
        await expect(button).toHaveCount(0);
        await setSubtitleTrack(page, TRACKS.chinese);
        await page.waitForTimeout(1500);
        await expect(button).toHaveCount(0);
        await setSubtitleTrack(page, TRACKS.untagged);
        await expect(button).toHaveCount(1);
        await setSubtitleTrack(page, TRACKS.japanese);
        await expect(button).toHaveCount(1);
        await expect(page.locator(BUTTON)).toHaveCount(1);
    });

    test('never for image subtitles, whatever their language', async ({page}) => {
        await logIn(page, {settings: {enabled: false}});
        await play(page, movies.ImageSample, {subtitleStreamIndex: 2, minimumTime: 1.5});
        await page.waitForTimeout(800);
        await expect(page.locator(BUTTON)).toHaveCount(0);
    });

    test('and it goes with the video', async ({page}) => {
        await startOff(page);
        await stopPlayback(page);
        await expect(page.locator(BUTTON)).toHaveCount(0);
    });
});

test('with no dictionaries, turning it on says so, and leaves the subtitles alone', async ({page, isMobile}) => {
    await deleteAll(admin);
    try {
        await startOff(page);
        await press(page, isMobile);
        await expect(page.locator('.yomitan-notice')).toContainText('no dictionaries');
        expect(await pressed(page)).toBe('true');
        await expect(page.locator(BUTTON)).toHaveAttribute('aria-label', /not working/);
        await expect.poll(() => jellyfinLine(page)).toBe('showing');
        expect(await page.locator('.yomitan-overlay').count()).toBe(0);
    } finally {
        await importArchive(admin, makeMiniDictionary());
    }
});

test('it shows that the dictionaries are switched off, if they all are', async ({page}) => {
    await logIn(page, {settings: {enabled: true, disabledDictionaries: ['Mini']}});
    await play(page, movies.LookupSample, {subtitleStreamIndex: 0, minimumTime: 0.5});
    await expect(page.locator('.yomitan-notice')).toContainText('turned off');
    await expect.poll(() => jellyfinLine(page)).toBe('showing');
});

test.describe('it fails safely', () => {
    test('in an OSD it does not recognise, nothing is added and the OSD goes on working', async ({page, isMobile}) => {
        await page.addInitScript(() => {
            // jellyfin-web itself finds these by a class of its own, so this is an OSD that changed under the plugin.
            new MutationObserver(() => {
                document.querySelector('.videoOsdBottom-maincontrols.videoOsdBottom')?.classList.remove('videoOsdBottom');
            }).observe(document, {childList: true, subtree: true});
        });
        await logIn(page, {settings: {enabled: false}});
        await play(page, movies.LookupSample, {subtitleStreamIndex: 0, minimumTime: 1});
        await page.waitForTimeout(1000);
        await expect(page.locator(BUTTON)).toHaveCount(0);
        // jellyfin-web ignores a click from a script in Firefox, so a key does it where there are keys.
        await (isMobile ? page.locator('.btnPause').evaluate((button) => button.click()) : page.keyboard.press('k'));
        await expect.poll(() => isPaused(page)).toBe(true);
    });

    test('with the button taken out from under it, it does nothing and throws nothing', async ({page}) => {
        await logIn(page, {settings: {enabled: false}});
        await play(page, movies.LookupSample, {subtitleStreamIndex: 0, minimumTime: 0.5});
        await page.locator(BUTTON).waitFor({state: 'attached'});
        // The fixture fails this test on any uncaught error in the page.
        await page.evaluate(() => {
            const button = document.querySelector('.btnYomitan');
            button.parentElement.replaceChildren();
        });
        await page.waitForTimeout(1000);
        await expect(page.locator(BUTTON)).toHaveCount(0);
    });
});

test.describe('with a keyboard or a remote', () => {
    // The size keys.spec.mjs uses for the TV layout. At a smaller one, Sign In does nothing there in Firefox or WebKit.
    test.use({viewport: {width: 1920, height: 1080}});
    test.skip(({isMobile}) => isMobile, 'A phone has no keys.');
    test.beforeEach(async ({page}) => {
        await useTvLayout(page);
    });

    test('it is one more stop in the row, Enter presses it, and nothing else happens', async ({page}) => {
        await startOff(page);
        await expect(page.locator('html.layout-tv')).toHaveCount(1);
        await page.keyboard.press('Enter');
        await expect.poll(() => osdShowing(page)).toBe(true);
        await page.evaluate(() => document.querySelector('.btnSubtitles').focus());
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => page.evaluate(() => document.activeElement?.className)).toContain('btnYomitan');
        const paused = await isPaused(page);

        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.__yomitanJellyfin.playback?.session?.state === 'active');
        expect(await pressed(page)).toBe('true');
        expect(await isPaused(page)).toBe(paused);
        expect(await page.evaluate(() => document.activeElement?.className)).toContain('btnYomitan');

        // Enter paused the video, and on a paused video Left enters word mode, unless the user chose Up only.
        await page.evaluate(() => window.__yomitanJellyfin.settings.set('upOnlyEntry', true));
        // The OSD hides by itself and takes the focus with it, so moving the mouse starts its clock over first.
        await page.mouse.move(300, 300, {steps: 2});
        await expect.poll(() => osdShowing(page)).toBe(true);
        await page.evaluate(() => document.querySelector('.btnYomitan').focus());
        await page.keyboard.press('ArrowLeft');
        await expect.poll(() => page.evaluate(() => document.activeElement?.className)).toContain('btnSubtitles');
    });

    test('it does not get in the way of word mode', async ({page}) => {
        await logIn(page);
        await play(page, movies.LookupSample, {subtitleStreamIndex: 0, minimumTime: 0.5});
        await page.waitForFunction(() => window.__yomitanJellyfin.playback?.session?.state === 'active');
        await showLine(page, LINES.plain);
        await parkMouse(page);
        await page.evaluate(() => document.querySelector('video.htmlvideoplayer').pause());
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, '昨日');
        expect(await inWordMode(page)).toBe(true);
    });
});

test('it opens and closes with the rest of the OSD, in the same row', async ({page, isMobile}) => {
    await startOff(page);
    await showOsd(page, isMobile);
    const row = await page.evaluate(() => {
        const button = document.querySelector('.btnYomitan');
        const subtitles = document.querySelector('.btnSubtitles');
        const a = button.getBoundingClientRect();
        const b = subtitles.getBoundingClientRect();
        return {sameParent: button.parentElement === subtitles.parentElement, next: subtitles.nextElementSibling === button, width: a.width, height: a.height, top: a.top - b.top, right: a.right, viewport: innerWidth};
    });
    expect(row).toMatchObject({sameParent: true, next: true, top: 0});
    expect(row.width).toBeGreaterThanOrEqual(40);
    expect(row.right).toBeLessThanOrEqual(row.viewport);
});
