// All three of jellyfin-web's ways of drawing subtitles, in real playback: hidden while the overlay is up, and back as
// soon as it goes, however it goes.
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {credentials, getMovies, logIn, play} from '../lib/jellyfin.mjs';
import {expectPopup, isPaused, LINES, moveToWord, parkMouse, showLine} from '../lib/lookup.mjs';
import {makeMiniDictionary} from '../lib/mini-dictionary.mjs';
import {expectTrack, jellyfinLine, nativeState, overlayText, setSubtitleTrack, setVideoTime, stopPlayback} from '../lib/player.mjs';
import {expect, test} from '../lib/test.mjs';

test.describe.configure({timeout: 120_000});

const LOOKUP_TRACK = 0;
const ENGLISH_TRACK = 0;
const TRACKS_JAPANESE = 2;
const ASS_TRACK = 2;

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

/** Turns on jellyfin-web's "Custom" subtitle styling for this user, which is its setting for drawing cues in the DOM. */
function useCustomElement(page) {
    return page.evaluate(() => {
        const key = `${window.ApiClient.getCurrentUserId()}-localplayersubtitleappearance3`;
        localStorage.setItem(key, JSON.stringify({subtitleStyling: 'Custom'}));
    });
}

const visibility = (page, selector) => page.evaluate((target) => {
    const element = document.querySelector(target);
    return element ? getComputedStyle(element).visibility : null;
}, selector);

test.describe('native cues', () => {
    test.skip(({browserName}) => browserName !== 'chromium', 'jellyfin-web draws text in the custom element in Firefox and WebKit.');

    test('hidden while the overlay is up, showing with its cues again after a failure', async ({page}) => {
        await logIn(page);
        await play(page, movies.TracksSample, {subtitleStreamIndex: TRACKS_JAPANESE, minimumTime: 1});
        await expectTrack(page, {state: 'active'});
        await expect.poll(async () => (await nativeState(page)).tracks[0]?.mode).toBe('hidden');

        await page.evaluate(() => window.__yomitanJellyfin.playback.session._fail(new Error('from a test')));
        const state = await nativeState(page);
        expect(state.hiding).toBe(false);
        expect(state.overlay).toBe(false);
        expect(state.tracks[0].mode).toBe('showing');
        expect(state.tracks[0].cues).toBeGreaterThan(0);
    });

});

test('going to a track that is not Japanese brings Jellyfin\'s line back', async ({page}) => {
    await logIn(page);
    await play(page, movies.TracksSample, {subtitleStreamIndex: TRACKS_JAPANESE, minimumTime: 1});
    await expectTrack(page, {state: 'active'});
    await expect.poll(() => jellyfinLine(page)).toBe('hidden');
    await setSubtitleTrack(page, ENGLISH_TRACK);
    await expectTrack(page, {state: 'inactive', language: 'eng'});
    await expect.poll(() => nativeState(page)).toMatchObject({hiding: false, overlay: false});
    await expect.poll(() => jellyfinLine(page)).toBe('showing');
});

// An iPhone has no fullscreen for a page. Its fullscreen hands the video to iOS's own player, where nothing of the page
// shows, so for that time the line goes back to Jellyfin.
test.describe('the video fullscreen by itself', () => {
    const layerShowing = (page) => page.evaluate(() => {
        const layer = document.querySelector('.yomitan-layer');
        return layer !== null && getComputedStyle(layer).display !== 'none';
    });

    test('as an iPhone does it: Jellyfin\'s line comes back, the popup goes, and the overlay returns after', async ({page, isMobile}) => {
        await logIn(page);
        await play(page, movies.LookupSample, {subtitleStreamIndex: LOOKUP_TRACK, minimumTime: 0.2});
        await expectTrack(page, {state: 'active'});
        await showLine(page, LINES.plain);
        await expect.poll(() => jellyfinLine(page)).toBe('hidden');
        if (!isMobile) {
            await parkMouse(page);
            await moveToWord(page, '学校');
            await expectPopup(page, '学校');
        }

        // What WebKit on an iPhone does when the player's button calls webkitEnterFullscreen(). These browsers have no such
        // player, so the test plays its part.
        const iPhoneFullscreen = (on) => page.evaluate((value) => {
            const video = document.querySelector('video.htmlvideoplayer');
            Object.defineProperty(video, 'webkitDisplayingFullscreen', {configurable: true, get: () => value});
            video.dispatchEvent(new Event(value ? 'webkitbeginfullscreen' : 'webkitendfullscreen'));
        }, on);
        await iPhoneFullscreen(true);
        await expect.poll(() => jellyfinLine(page)).toBe('showing');
        expect(await layerShowing(page)).toBe(false);
        expect(await page.locator('.yomitan-popup:not([hidden])').count()).toBe(0);
        await expect.poll(() => isPaused(page)).toBe(false);
        expect(await page.evaluate(() => window.__yomitanJellyfin.playback.session.state)).toBe('active');

        await iPhoneFullscreen(false);
        await expect.poll(() => jellyfinLine(page)).toBe('hidden');
        expect(await layerShowing(page)).toBe(true);
        await showLine(page, LINES.plain);
        expect(await overlayText(page)).toContain('昨日');
    });

    test('the same when the video element alone is the fullscreen element', async ({page}) => {
        await logIn(page);
        await play(page, movies.LookupSample, {subtitleStreamIndex: LOOKUP_TRACK, minimumTime: 0.2});
        await expectTrack(page, {state: 'active'});
        await expect.poll(() => jellyfinLine(page)).toBe('hidden');
        const entered = await page.evaluate(() => document.querySelector('video.htmlvideoplayer').requestFullscreen().then(() => true, () => false));
        test.skip(!entered, 'This browser has no fullscreen here.');

        await expect.poll(() => jellyfinLine(page)).toBe('showing');
        expect(await layerShowing(page)).toBe(false);
        await page.evaluate(() => document.exitFullscreen());
        await expect.poll(() => jellyfinLine(page)).toBe('hidden');
        expect(await layerShowing(page)).toBe(true);
    });
});

test.describe('the custom element', () => {
    test('jellyfin-web really draws there, and the plugin hides it and gives it back', async ({page}) => {
        await logIn(page);
        await useCustomElement(page);
        await play(page, movies.LookupSample, {subtitleStreamIndex: LOOKUP_TRACK, minimumTime: 1});
        await expectTrack(page, {state: 'active', language: 'jpn'});
        await expect.poll(() => page.evaluate(() => document.querySelector('.videoSubtitlesInner')?.textContent ?? '')).toContain('昨日');
        expect(await page.evaluate(() => document.querySelector('video.htmlvideoplayer').textTracks.length)).toBe(0);
        expect(await visibility(page, '.videoSubtitlesInner')).toBe('hidden');

        await page.evaluate(() => window.__yomitanJellyfin.playback.session._fail(new Error('from a test')));
        expect(await visibility(page, '.videoSubtitlesInner')).toBe('visible');
        expect(await page.locator('.yomitan-overlay').count()).toBe(0);
    });

    test('stopping leaves no trace of the hiding for the next video', async ({page}) => {
        await logIn(page);
        await useCustomElement(page);
        await play(page, movies.LookupSample, {subtitleStreamIndex: LOOKUP_TRACK, minimumTime: 1});
        await expectTrack(page, {state: 'active'});
        await stopPlayback(page);
        await expect.poll(() => nativeState(page)).toMatchObject({hiding: false, overlay: false});
    });
});

test.describe('JASSUB', () => {
    test('its canvas is hidden, and shows again when the overlay goes', async ({page}) => {
        await logIn(page);
        await play(page, movies.AssSample, {subtitleStreamIndex: ASS_TRACK, minimumTime: 1});
        await expectTrack(page, {state: 'active', language: 'jpn', codec: 'ass'});
        await page.waitForFunction(() => document.querySelector('.libassjs-canvas'), null, {timeout: 20_000});
        expect(await visibility(page, '.libassjs-canvas')).toBe('hidden');

        await page.evaluate(() => window.__yomitanJellyfin.playback.session._fail(new Error('from a test')));
        expect(await visibility(page, '.libassjs-canvas')).toBe('visible');
    });

    test('a canvas that arrives after the overlay is hidden too, and leaving clears it', async ({page}) => {
        await logIn(page);
        await play(page, movies.AssSample, {subtitleStreamIndex: ASS_TRACK, minimumTime: 1});
        await expectTrack(page, {state: 'active'});
        await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.className = 'libassjs-canvas late-test-canvas';
            document.querySelector('.videoPlayerContainer').append(canvas);
        });
        expect(await visibility(page, '.late-test-canvas')).toBe('hidden');
        await stopPlayback(page);
        await expect.poll(() => nativeState(page)).toMatchObject({hiding: false, overlay: false});
    });
});

test.describe('navigation', () => {
    for (const [name, leave] of [
        ['stop', stopPlayback],
        ['the browser\'s back button', (page) => page.goBack()],
    ]) {
        test(`${name} leaves the page as it found it`, async ({page}) => {
            await logIn(page);
            await play(page, movies.TracksSample, {subtitleStreamIndex: TRACKS_JAPANESE, minimumTime: 1});
            await expectTrack(page, {state: 'active'});
            await leave(page);
            await expect.poll(() => page.evaluate(() => ({
                layer: document.querySelector('.yomitan-layer') !== null,
                hiding: document.documentElement.hasAttribute('data-yomitan-hides-subtitles'),
                session: window.__yomitanJellyfin.playback.session,
            }))).toEqual({layer: false, hiding: false, session: null});
        });
    }

    test('a seek does not lose the hiding', async ({page}) => {
        await logIn(page);
        await play(page, movies.TracksSample, {subtitleStreamIndex: TRACKS_JAPANESE, minimumTime: 1});
        await expectTrack(page, {state: 'active'});
        await setVideoTime(page, 30);
        await page.waitForTimeout(800);
        expect(await jellyfinLine(page)).toBe('hidden');
    });
});
