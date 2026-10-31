// The whole pipeline in real playback: jellyfin-web, a real video element, and the plugin's overlay.
import {readFileSync} from 'node:fs';
import {expect, test} from '@playwright/test';
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {api, credentials, getEpisodes, getMovies, logIn, play, server} from '../lib/jellyfin.mjs';
import {makeMiniDictionary} from '../lib/mini-dictionary.mjs';
import {bundleYomitan} from '../lib/yomitan.mjs';
import {
    countListeners, cueTextAt, engineTimers, expectTrack, measureSync, nativeState, overlayText, overlayWords, readSrt,
    setSecondaryTrack, setSubtitleOffset, setSubtitleTrack, setVideoTime, signText, startRecording, stopPlayback,
    stopRecording, trackEngineTimers,
} from '../lib/player.mjs';

test.describe.configure({timeout: 120_000});

// Sidecars sort by language, so these are stable. expectTrack asserts them anyway.
const TRACKS = {english: 0, chinese: 1, japanese: 2, untagged: 3};
const syncCues = readSrt('sync.ja.srt');
const englishCues = readSrt('sync.en.srt');

let movies;
let admin;

test.beforeAll(async () => {
    admin = await clientFor(credentials.username, credentials.password);
    await deleteAll(admin);
    expect((await importArchive(admin, makeMiniDictionary())).state).toBe('succeeded');
    movies = await getMovies();
});

test.afterAll(async () => {
    await deleteAll(admin);
});

async function startJapanese(page, {minimumTime = 1} = {}) {
    await play(page, movies.TracksSample, {subtitleStreamIndex: TRACKS.japanese, minimumTime});
    await expectTrack(page, {state: 'active', language: 'jpn', codec: 'subrip', index: TRACKS.japanese});
}

test.describe('loading', () => {
    test('the engine stays away until a video starts', async ({page}) => {
        const engineRequests = [];
        page.on('request', (request) => {
            if (request.url().includes('/Yomitan/engine.js')) {
                engineRequests.push(request.url());
            }
        });

        await logIn(page);
        await page.waitForTimeout(1000);
        expect(engineRequests).toEqual([]);

        await play(page, movies.SrtSample);
        await expect.poll(() => engineRequests.length).toBe(1);
        expect(new URL(engineRequests[0]).pathname).toBe(`${server.prefix}/Yomitan/engine.js`);
        expect(new URL(engineRequests[0]).search).toMatch(/^\?v=[0-9a-f]{16}$/);
    });

    test('the plugin puts nothing in the page on the way to the video', async ({page}) => {
        await logIn(page);
        const state = await page.evaluate(() => ({
            style: document.getElementById('yomitan-overlay-style') !== null,
            attribute: document.documentElement.hasAttribute('data-yomitan-hides-subtitles'),
        }));
        expect(state).toEqual({style: false, attribute: false});
    });
});

test.describe('in sync', () => {
    test('direct play stays within 100 ms of the file, frame by frame', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        await startRecording(page);
        await page.waitForTimeout(9000);
        const samples = await stopRecording(page);
        const sync = measureSync(samples, syncCues);
        console.log(`direct play: ${sync.frames} frames, ${sync.wrongFrames} wrong, worst ${(sync.worstSeconds * 1000).toFixed(1)} ms`);
        expect(sync.frames).toBeGreaterThan(50);
        expect(sync.worstSeconds).toBeLessThan(0.1);
    });

    test('a seek shows the right line at once, playing or paused', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        await startRecording(page);
        for (const target of [20.5, 5, 40.7, 30.2]) {
            await setVideoTime(page, target);
            await page.waitForTimeout(1200);
        }

        await page.evaluate(() => document.querySelector('video.htmlvideoplayer').pause());
        for (const target of [12.4, 44.9, 3]) {
            await setVideoTime(page, target);
            await page.waitForFunction((time) => {
                const video = document.querySelector('video.htmlvideoplayer');
                return !video.seeking && Math.abs(video.currentTime - time) < 0.5;
            }, target);
            await page.waitForTimeout(400);
            const time = await page.evaluate(() => document.querySelector('video.htmlvideoplayer').currentTime);
            expect(await overlayText(page)).toBe(cueTextAt(syncCues, time));
        }

        const sync = measureSync(await stopRecording(page), syncCues);
        console.log(`seeks: ${sync.frames} frames, ${sync.wrongFrames} wrong, worst ${(sync.worstSeconds * 1000).toFixed(1)} ms`);
        expect(sync.worstSeconds).toBeLessThan(0.1);
    });

    test('pausing keeps the line, and resuming carries on', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        await page.waitForFunction(() => document.querySelector('.yomitan-lines .yomitan-word'));
        await page.evaluate(() => document.querySelector('video.htmlvideoplayer').pause());
        const time = await page.evaluate(() => document.querySelector('video.htmlvideoplayer').currentTime);
        const paused = await overlayText(page);
        await page.waitForTimeout(600);
        expect(await overlayText(page)).toBe(paused);
        expect(paused).toBe(cueTextAt(syncCues, time));

        await page.evaluate(() => document.querySelector('video.htmlvideoplayer').play());
        await startRecording(page);
        await page.waitForTimeout(3000);
        expect(measureSync(await stopRecording(page), syncCues).worstSeconds).toBeLessThan(0.1);
    });

    test('a faster playback rate stays in sync', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        await page.evaluate(() => {
            document.querySelector('video.htmlvideoplayer').playbackRate = 2;
        });
        await startRecording(page);
        await page.waitForTimeout(6000);
        const sync = measureSync(await stopRecording(page), syncCues);
        console.log(`double speed: ${sync.frames} frames, worst ${(sync.worstSeconds * 1000).toFixed(1)} ms`);
        expect(sync.worstSeconds).toBeLessThan(0.15);
    });
});

test.describe('the overlay', () => {
    test('it replaces the native line: the track is hidden and keeps its cues', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        const state = await nativeState(page);
        expect(state.hiding).toBe(true);
        expect(state.overlay).toBe(true);
        expect(state.tracks).toEqual([{mode: 'hidden', label: 'manualTrack', cues: syncCues.length}]);
    });

    test('words are spans whose ranges index the cue text', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        await setVideoTime(page, 6.2);
        await page.waitForFunction(() => document.querySelector('.yomitan-word')?.textContent === 'は');
        const words = await overlayWords(page);
        const text = await overlayText(page);
        expect(text).toBe('はコーヒーを飲みます');
        expect(words.map((word) => word.text)).toEqual(['は', 'コーヒー', 'を', '飲みます']);
        for (const word of words) {
            expect(text.slice(word.start, word.end)).toBe(word.text);
        }
    });

    test('it takes no input, so clicks reach the player', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        const position = await page.evaluate(() => {
            const {left, top, width, height} = document.querySelector('.yomitan-lines').getBoundingClientRect();
            return {x: left + width / 2, y: top + height / 2};
        });
        const target = await page.evaluate(({x, y}) => document.elementFromPoint(x, y).className, position);
        expect(target).not.toContain('yomitan');
    });

    test('a line break in a cue survives, and text stays selectable as Japanese', async ({page}) => {
        await logIn(page);
        await play(page, movies.AssSample, {subtitleStreamIndex: 2, minimumTime: 3});
        await expectTrack(page, {state: 'active', language: 'jpn', codec: 'ass'});
        await page.waitForFunction(() => document.querySelector('.yomitan-line br'));
        expect(await overlayText(page)).toBe('昨日は学校に行きませんでした');
        expect(await page.locator('.yomitan-overlay').getAttribute('lang')).toBe('ja');
    });

    test('a fansub script through the real server: comments, layers, signs and speakers', async ({page}) => {
        await logIn(page);
        await play(page, movies.TypesetSample, {subtitleStreamIndex: 2, minimumTime: 1});
        await expectTrack(page, {state: 'active', language: 'jpn', codec: 'ass'});

        for (const [time, lines, signs] of [
            [6.5, '彼女はケーキを 食べられなかった\nえっ、本当に？', ''],
            [11, '重ねた行です', ''],
            [14, '看板の前で話す', '駅前商店街'],
            [17, '', '追跡する看板'],
            [20, '', 'そっと開いたドアの向こうに'],
            [24.2, '', ''],
            [26, '', '第一話旅立ちの朝'],
            [29, '朝の話だよね', ''],
        ]) {
            await setVideoTime(page, time);
            await page.waitForFunction((target) => {
                const video = document.querySelector('video.htmlvideoplayer');
                return !video.seeking && Math.abs(video.currentTime - target) < 0.6;
            }, time);
            await expect.poll(() => overlayText(page)).toBe(lines);
            expect(await signText(page)).toBe(signs);
        }
    });

    test('the libass canvas is hidden, and shows again when the track goes', async ({page}) => {
        await logIn(page);
        await play(page, movies.TypesetSample, {subtitleStreamIndex: 2, minimumTime: 1});
        await expectTrack(page, {state: 'active', codec: 'ass'});
        const canvasVisibility = () => page.evaluate(() => {
            const canvas = document.querySelector('.libassjs-canvas');
            return canvas ? getComputedStyle(canvas).visibility : 'no canvas';
        });
        await expect.poll(canvasVisibility).toBe('hidden');

        await setSubtitleTrack(page, -1);
        await expect.poll(async () => (await nativeState(page)).hiding).toBe(false);
        expect(await page.evaluate(() => document.querySelector('.yomitan-overlay'))).toBeNull();
    });
});

test.describe('only Japanese', () => {
    test('an English track stays exactly as Jellyfin renders it', async ({page}) => {
        await logIn(page);
        await play(page, movies.TracksSample, {subtitleStreamIndex: TRACKS.english});
        await expectTrack(page, {state: 'inactive', language: 'eng', index: TRACKS.english});
        const state = await nativeState(page);
        expect(state).toMatchObject({hiding: false, overlay: false, tracks: [{mode: 'showing', label: 'manualTrack'}]});

        // Selecting the track that is already the default can make jellyfin-web add its cues twice, on its own.
        expect(state.tracks[0].cues % englishCues.length).toBe(0);
        await startRecording(page);
        await page.waitForTimeout(1000);
        expect((await stopRecording(page)).every(({text}) => text === '')).toBe(true);
    });

    test('an untagged Japanese track activates by its text', async ({page}) => {
        await logIn(page);
        await play(page, movies.TracksSample, {subtitleStreamIndex: TRACKS.untagged});
        const {language} = await expectTrack(page, {state: 'active', index: TRACKS.untagged});
        expect(language ?? null).toBeNull();
        await expect.poll(() => overlayText(page)).toContain('もう一つの字幕です');
    });

    test('an untagged Chinese track does not', async ({page}) => {
        await logIn(page);
        await play(page, movies.TracksSample, {subtitleStreamIndex: TRACKS.chinese});
        const {language} = await expectTrack(page, {state: 'inactive', index: TRACKS.chinese});
        expect(language ?? null).toBeNull();
        expect(await nativeState(page)).toMatchObject({hiding: false, overlay: false});
    });
});

test.describe('tracks that hold no text', () => {
    test('an image track is left alone, logged once, and the video plays on', async ({page}) => {
        const logged = [];
        page.on('console', (message) => {
            if (message.text().includes('leaving subtitle stream')) {
                logged.push(message.type());
            }
        });

        await logIn(page);
        await play(page, movies.ImageSample, {subtitleStreamIndex: 2, minimumTime: 2});
        const {codec} = await expectTrack(page, {state: 'inactive', language: 'jpn'});
        expect(codec.toLowerCase()).toBe('pgssub');

        const time = await page.evaluate(() => document.querySelector('video.htmlvideoplayer').currentTime);
        await page.waitForTimeout(1500);
        expect(await page.evaluate(() => document.querySelector('video.htmlvideoplayer').currentTime)).toBeGreaterThan(time);
        expect(await nativeState(page)).toMatchObject({hiding: false, overlay: false});
        expect(logged).toEqual(['debug']);
    });

    test('with burn-in, the plugin does nothing', async ({page}) => {
        await logIn(page);
        await page.evaluate(() => {
            localStorage.setItem('alwaysBurnInSubtitleWhenTranscoding', 'true');
            localStorage.setItem('maxbitrate-Video-true', '100000');
            localStorage.setItem('maxbitrate-Video-false', '100000');
        });
        await page.reload();
        await page.waitForFunction(() => window.ApiClient?.isLoggedIn());

        await play(page, movies.TranscodeSample, {subtitleStreamIndex: 0, minimumTime: 1});
        await page.waitForFunction(() => window.__yomitanJellyfin.playback);
        await expect.poll(() => page.evaluate(() => {
            const {session} = window.__yomitanJellyfin.playback;
            return session ? `${session.state}/${session.stream.DeliveryMethod}` : 'none';
        })).toBe('inactive/Encode');
        expect(await nativeState(page)).toMatchObject({hiding: false, overlay: false});
    });
});

test.describe('failing safe', () => {
    test('a query that fails from the start leaves Jellyfin\'s subtitles showing, without so much as a flicker', async ({page}) => {
        await page.addInitScript(() => {
            window.hidCount = 0;
            new MutationObserver(() => {
                window.hidCount += document.documentElement.hasAttribute('data-yomitan-hides-subtitles') ? 1 : 0;
            }).observe(document, {subtree: true, attributes: true, attributeFilter: ['data-yomitan-hides-subtitles']});
        });
        await page.route('**/Yomitan/Query', (route) => route.fulfill({status: 500, body: 'broken'}));
        await logIn(page);
        await play(page, movies.TracksSample, {subtitleStreamIndex: TRACKS.japanese});
        await expectTrack(page, {state: 'inactive', index: TRACKS.japanese});
        await expect.poll(async () => (await nativeState(page)).tracks[0]?.mode).toBe('showing');
        expect(await nativeState(page)).toMatchObject({hiding: false, overlay: false});
        expect(await page.evaluate(() => window.hidCount)).toBe(0);
    });

    test('a query that starts failing in mid-playback gives the native line back', async ({page}) => {
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await logIn(page);
        await startJapanese(page);
        await page.route('**/Yomitan/Query', (route) => route.fulfill({status: 500, body: 'broken'}));

        // The next line the client has not seen asks the server.
        await setVideoTime(page, 30.2);
        await expectTrack(page, {state: 'inactive', index: TRACKS.japanese});
        expect(await nativeState(page)).toEqual({
            hiding: false,
            overlay: false,
            tracks: [{mode: 'showing', label: 'manualTrack', cues: syncCues.length}],
        });

        const time = await page.evaluate(() => document.querySelector('video.htmlvideoplayer').currentTime);
        await page.waitForTimeout(800);
        expect(await page.evaluate(() => document.querySelector('video.htmlvideoplayer').currentTime)).toBeGreaterThan(time);

        // The video keeps firing events, and nothing of ours may still be listening.
        await setVideoTime(page, 12);
        await page.waitForTimeout(800);
        expect(errors).toEqual([]);
    });

    for (const [name, fail] of [
        ['a 503', (route) => route.fulfill({status: 503, body: 'restarting'})],
        ['a dropped connection', (route) => route.abort('connectionfailed')],
    ]) {
        test(`${name} that clears up keeps the overlay`, async ({page}) => {
            await logIn(page);
            await startJapanese(page);
            let failures = 0;
            await page.route('**/Yomitan/Query', (route) => {
                failures += 1;
                return failures <= 2 ? fail(route) : route.continue();
            });

            await setVideoTime(page, 30.2);
            await expect.poll(() => failures).toBeGreaterThan(2);
            await expect.poll(() => overlayWords(page).then((words) => words.length)).toBeGreaterThan(0);
            await expectTrack(page, {state: 'active', index: TRACKS.japanese});
        });
    }

    test('a query the server refuses is not retried', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        let requests = 0;
        await page.route('**/Yomitan/Query', (route) => {
            requests += 1;
            return route.fulfill({status: 400, body: '{}'});
        });

        await setVideoTime(page, 30.2);
        await expectTrack(page, {state: 'inactive', index: TRACKS.japanese});
        expect(requests).toBe(1);
    });

    test('a Stream.js 404 leaves Jellyfin\'s subtitles showing', async ({page}) => {
        // Jellyfin fetches the same URL with its key in the query, so only the plugin's request fails.
        await page.route('**/Subtitles/**', (route) => (
            route.request().headers().authorization ? route.fulfill({status: 404, body: ''}) : route.continue()
        ));
        await logIn(page);
        await play(page, movies.TracksSample, {subtitleStreamIndex: TRACKS.japanese});
        await expectTrack(page, {state: 'inactive', index: TRACKS.japanese});
        await expect.poll(async () => (await nativeState(page)).tracks[0]?.mode).toBe('showing');
        expect(await nativeState(page)).toMatchObject({hiding: false, overlay: false});
    });

    test('an ASS script that cannot be fetched falls back to timed text', async ({page}) => {
        await page.route('**/Stream.ass*', (route) => (
            route.request().headers().authorization ? route.fulfill({status: 500, body: ''}) : route.continue()
        ));
        await logIn(page);
        await play(page, movies.AssSample, {subtitleStreamIndex: 2, minimumTime: 3});
        await expectTrack(page, {state: 'active', codec: 'ass'});
        await expect.poll(() => overlayText(page)).toBe('昨日は学校に行きませんでした');
    });

    test('an engine that will not load leaves playback alone', async ({page}) => {
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/Yomitan/engine.js*', (route) => route.fulfill({status: 500, body: ''}));
        await logIn(page);
        await play(page, movies.TracksSample, {subtitleStreamIndex: TRACKS.japanese});
        await expect.poll(async () => (await nativeState(page)).tracks[0]?.mode).toBe('showing');
        expect(await nativeState(page)).toMatchObject({hiding: false, overlay: false});
        expect(errors).toEqual([]);
    });

    test('with no dictionaries, Jellyfin\'s subtitles stay', async ({page}) => {
        await deleteAll(admin);
        try {
            await logIn(page);
            await play(page, movies.TracksSample, {subtitleStreamIndex: TRACKS.japanese});
            await expectTrack(page, {state: 'inactive', index: TRACKS.japanese});
            await expect.poll(async () => (await nativeState(page)).tracks[0]?.mode).toBe('showing');
            expect(await nativeState(page)).toMatchObject({hiding: false, overlay: false});
        } finally {
            expect((await importArchive(admin, makeMiniDictionary())).state).toBe('succeeded');
        }
    });
});

test.describe('switching tracks', () => {
    test('from Japanese to English, off, and back, mid-playback', async ({page}) => {
        await logIn(page);
        await startJapanese(page);

        await setSubtitleTrack(page, TRACKS.english);
        await expect.poll(async () => (await nativeState(page)).hiding).toBe(false);
        await expect.poll(async () => (await nativeState(page)).tracks[0]?.mode).toBe('showing');
        await expectTrack(page, {state: 'inactive', index: TRACKS.english, language: 'eng'});
        expect((await nativeState(page)).overlay).toBe(false);

        await setSubtitleTrack(page, -1);
        await expect.poll(() => page.evaluate(() => window.__yomitanJellyfin.playback.session)).toBeNull();
        expect(await nativeState(page)).toMatchObject({hiding: false, overlay: false});

        await setSubtitleTrack(page, TRACKS.untagged);
        await expectTrack(page, {state: 'active', index: TRACKS.untagged});
        await startRecording(page);
        await page.waitForTimeout(4000);
        const samples = await stopRecording(page);
        const sync = measureSync(samples, readSrt('untagged-japanese.srt'));
        console.log(`after a track switch: ${sync.frames} frames, ${sync.wrongFrames} wrong, worst ${(sync.worstSeconds * 1000).toFixed(1)} ms`);
        expect(sync.worstSeconds).toBeLessThan(0.1);
    });

    test('a switch while paused is noticed', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        await page.evaluate(() => document.querySelector('video.htmlvideoplayer').pause());
        await setSubtitleTrack(page, TRACKS.english);
        await expect.poll(async () => (await nativeState(page)).overlay).toBe(false);
    });
});

test.describe('the subtitle offset', () => {
    // jellyfin-web keeps it in the player and subtracts it from each cue's times, so +2 shows a line 2 s early.
    for (const offset of [2, -3]) {
        test(`${offset > 0 ? '+' : ''}${offset} s moves the overlay as it moves the native line`, async ({page}) => {
            await logIn(page);
            await startJapanese(page);
            await setVideoTime(page, 10);
            await setSubtitleOffset(page, offset);
            await page.waitForFunction((value) => {
                const manager = window.__yomitanJellyfin.playback.playbackManager;
                return manager.getPlayerSubtitleOffset(manager.getCurrentPlayer()) === value;
            }, offset);
            await page.waitForTimeout(300);

            await startRecording(page);
            await page.waitForTimeout(5000);
            const sync = measureSync(await stopRecording(page), syncCues, (time) => time + offset);
            console.log(`offset ${offset}: ${sync.frames} frames, ${sync.wrongFrames} wrong, worst ${(sync.worstSeconds * 1000).toFixed(1)} ms`);
            expect(sync.worstSeconds).toBeLessThan(0.1);
        });
    }

    test('an offset set while paused moves the line without playing', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        await setVideoTime(page, 10.2);
        await page.evaluate(() => document.querySelector('video.htmlvideoplayer').pause());
        await expect.poll(() => overlayText(page)).toBe(cueTextAt(syncCues, 10.2));
        await setSubtitleOffset(page, 4);
        await expect.poll(() => overlayText(page)).toBe(cueTextAt(syncCues, 14.2));
    });

    test('native cues catch up with an offset set while they were hidden', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        await setSubtitleOffset(page, 2);
        await page.waitForTimeout(400);

        await page.route('**/Yomitan/Query', (route) => route.fulfill({status: 500, body: 'broken'}));
        await setVideoTime(page, 30.2);
        await expectTrack(page, {state: 'inactive'});
        const first = await page.evaluate(() => document.querySelector('video.htmlvideoplayer').textTracks[0].cues[0].startTime);
        expect(first).toBeCloseTo(syncCues[0].start - 2, 3);
    });

    test('an offset on an ASS track moves the overlay too', async ({page}) => {
        await logIn(page);
        await play(page, movies.TypesetSample, {subtitleStreamIndex: 2, minimumTime: 1});
        await expectTrack(page, {state: 'active', codec: 'ass'});
        await setVideoTime(page, 10.5);
        await page.evaluate(() => document.querySelector('video.htmlvideoplayer').pause());
        await expect.poll(() => overlayText(page)).toBe('重ねた行です');
        await setSubtitleOffset(page, 18.5);
        await expect.poll(() => overlayText(page)).toBe('朝の話だよね');
    });
});

test.describe('segmenting ahead', () => {
    test('a line\'s words are ready before it shows, and each new line costs at most one request', async ({page}) => {
        const requests = [];
        page.on('request', (request) => {
            if (request.url().endsWith('/Yomitan/Query')) {
                requests.push(request.url());
            }
        });

        await logIn(page);
        await startJapanese(page, {minimumTime: 0.5});
        await page.waitForTimeout(12_000);
        const timings = await page.evaluate(() => window.__yomitanJellyfin.playback.session.timings);
        expect(timings.length).toBeGreaterThanOrEqual(5);

        // The first line shown had no line before it to get ready on.
        expect(timings.slice(1).filter(({ready}) => ready).length).toBe(timings.length - 1);
        expect(requests.length).toBeLessThanOrEqual(timings.length + 4);
    });
});

test.describe('secondary subtitles', () => {
    test('the secondary track stays showing, and the overlay moves up out of its way', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        await setSecondaryTrack(page, TRACKS.english);
        await expect.poll(async () => (await nativeState(page)).tracks[1]?.mode).toBe('showing');
        expect((await nativeState(page)).tracks[0].mode).toBe('hidden');

        await expect.poll(() => page.evaluate(() => document.querySelector('.yomitan-overlay').classList.contains('yomitan-below-secondary'))).toBe(true);
        await page.waitForFunction(() => document.querySelector('.yomitan-lines .yomitan-word'));

        // The secondary line is browser-painted, so find it in pixels: compare frames with and without it. The OSD
        // comes and goes on a pause, so it is kept out of the picture.
        await page.addStyleTag({content: '.videoOsdBottom, .skinHeader, .upNextContainer { display: none !important; }'});
        await page.evaluate(() => document.querySelector('video.htmlvideoplayer').pause());
        await page.waitForTimeout(500);
        const overlayBox = await page.locator('.yomitan-lines').boundingBox();
        await page.evaluate(() => {
            document.querySelector('.yomitan-overlay').style.visibility = 'hidden';
        });
        const withSecondary = await page.screenshot();
        await page.evaluate(() => {
            document.querySelector('video.htmlvideoplayer').textTracks[1].mode = 'hidden';
        });
        await page.waitForTimeout(300);
        const without = await page.screenshot();

        const box = await page.evaluate(async ([first, second]) => {
            const load = async (bytes) => {
                const blob = new Blob([new Uint8Array(bytes)], {type: 'image/png'});
                const bitmap = await createImageBitmap(blob);
                const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                const context = canvas.getContext('2d');
                context.drawImage(bitmap, 0, 0);
                return context.getImageData(0, 0, bitmap.width, bitmap.height);
            };

            const [a, b] = [await load(first), await load(second)];
            let top = Infinity;
            let bottom = -1;
            for (let y = 0; y < a.height; y += 1) {
                for (let x = 0; x < a.width; x += 1) {
                    const index = (y * a.width + x) * 4;
                    if (Math.abs(a.data[index] - b.data[index]) > 40) {
                        top = Math.min(top, y);
                        bottom = Math.max(bottom, y);
                    }
                }
            }

            return {top, bottom};
        }, [[...withSecondary], [...without]]);
        expect(box.bottom).toBeGreaterThan(0);
        expect(overlayBox.y + overlayBox.height).toBeLessThanOrEqual(box.top);
    });

    test('with custom subtitle styling, the secondary element stays visible while the primary is hidden', async ({page}) => {
        await logIn(page);
        await page.evaluate(() => {
            const key = `${window.ApiClient.getCurrentUserId()}-localplayersubtitleappearance3`;
            localStorage.setItem(key, JSON.stringify({subtitleStyling: 'Custom'}));
            localStorage.setItem('localplayersubtitleappearance3', JSON.stringify({subtitleStyling: 'Custom'}));
        });
        await page.reload();
        await page.waitForFunction(() => window.ApiClient?.isLoggedIn());
        await startJapanese(page);
        await setSecondaryTrack(page, TRACKS.english);
        await page.waitForFunction(() => document.querySelector('.videoSecondarySubtitlesInner')?.textContent);

        const state = await page.evaluate(() => ({
            primary: getComputedStyle(document.querySelector('.videoSubtitlesInner')).visibility,
            secondary: getComputedStyle(document.querySelector('.videoSecondarySubtitlesInner')).visibility,
        }));
        expect(state).toEqual({primary: 'hidden', secondary: 'visible'});

        await page.waitForFunction(() => document.querySelector('.yomitan-lines .yomitan-word'));
        const overlap = await page.evaluate(() => {
            const a = document.querySelector('.yomitan-lines').getBoundingClientRect();
            const b = document.querySelector('.videoSecondarySubtitlesInner').getBoundingClientRect();
            return a.bottom > b.top && b.bottom > a.top;
        });
        expect(overlap).toBe(false);
    });
});

test.describe('the next episode', () => {
    test('nothing carries over, and the new text shows', async ({page}) => {
        const episodes = await getEpisodes();
        await logIn(page);
        await page.evaluate(async ([first, second]) => {
            const {Id: id} = (await window.ApiClient.getSessions({deviceId: window.ApiClient.deviceId()}))[0];
            await window.ApiClient.sendPlayCommand(id, {PlayCommand: 'PlayNow', ItemIds: [first, second]});
        }, episodes);
        await page.waitForFunction(() => document.querySelector('.yomitan-lines .yomitan-word'), null, {timeout: 30_000});
        expect(await overlayText(page)).toContain('一話目');
        const firstSession = await page.evaluateHandle(() => window.__yomitanJellyfin.playback.session);

        await page.evaluate(() => {
            const manager = window.__yomitanJellyfin.playback.playbackManager;
            manager.nextTrack(manager.getCurrentPlayer());
        });
        await expect.poll(() => overlayText(page), {timeout: 20_000}).toContain('二話目');

        expect(await page.evaluate((old) => ({
            sameSession: old === window.__yomitanJellyfin.playback.session,
            disposed: old.disposed,
            overlays: document.querySelectorAll('.yomitan-overlay').length,
        }), firstSession)).toEqual({sameSession: false, disposed: true, overlays: 1});
    });
});

test.describe('the next episode, on its own', () => {
    test('the end of one episode rolls into the next with the right text', async ({page}) => {
        const episodes = await getEpisodes();
        await logIn(page);
        await page.evaluate(async ([first, second]) => {
            const {Id: id} = (await window.ApiClient.getSessions({deviceId: window.ApiClient.deviceId()}))[0];
            await window.ApiClient.sendPlayCommand(id, {PlayCommand: 'PlayNow', ItemIds: [first, second]});
        }, episodes);
        await page.waitForFunction(() => document.querySelector('.yomitan-lines .yomitan-word'), null, {timeout: 30_000});

        await setVideoTime(page, 29);
        await expect.poll(() => overlayText(page), {timeout: 30_000}).toContain('二話目');
        expect(await page.locator('.yomitan-overlay').count()).toBe(1);
    });
});

test.describe('two tabs on one deviceId', () => {
    async function openEpisode(page, id) {
        await page.goto(`web/#/details?id=${id}`);
        await page.locator('.detailPagePrimaryContainer .btnPlay, .mainDetailButtons .btnPlay').first().click();
        await page.waitForFunction(() => document.querySelector('.yomitan-lines .yomitan-word'), null, {timeout: 30_000});
    }

    test('each tab shows its own episode, though the server holds one session', async ({browser}) => {
        const episodes = await getEpisodes();
        const context = await browser.newContext({baseURL: `${server.url}/`});
        const first = await context.newPage();
        await logIn(first);
        const second = await context.newPage();
        await second.goto('web/');
        await second.waitForFunction(() => window.ApiClient?.isLoggedIn());

        const deviceId = await first.evaluate(() => window.ApiClient.deviceId());
        expect(await second.evaluate(() => window.ApiClient.deviceId())).toBe(deviceId);

        await openEpisode(first, episodes[0]);
        await openEpisode(second, episodes[1]);

        // The server cannot tell these tabs apart, which is why the plugin does not ask it.
        const sessions = await api(`/Sessions?deviceId=${encodeURIComponent(deviceId)}`);
        expect(sessions.length).toBe(1);

        // Each tab reports to that one session in turn, so give a wrong reading time to show. Lines of each episode
        // are on screen 90% of the time, so a blank tab has fallen back, which counts as a failure here.
        for (let check = 0; check < 6; check += 1) {
            await expect.poll(() => overlayText(first)).toContain('一話目');
            await expect.poll(() => overlayText(second)).toContain('二話目');
            await first.waitForTimeout(1500);
        }

        const stateOf = (page) => page.evaluate(() => window.__yomitanJellyfin.playback.session?.state);
        expect(await stateOf(first)).toBe('active');
        expect(await stateOf(second)).toBe('active');

        const itemOf = (page) => page.evaluate(() => {
            const manager = window.__yomitanJellyfin.playback.playbackManager;
            return manager.currentItem(manager.getCurrentPlayer()).Id;
        });
        expect(await itemOf(first)).toBe(episodes[0]);
        expect(await itemOf(second)).toBe(episodes[1]);
        await context.close();
    });
});

test.describe('a real transcode', () => {
    async function startTranscode(page) {
        await logIn(page);
        // The source is HEVC, and Chromium may still decode that, so a low bitrate makes sure it is transcoded.
        await page.evaluate(() => {
            localStorage.setItem('maxbitrate-Video-true', '150000');
            localStorage.setItem('maxbitrate-Video-false', '150000');
        });
        await page.reload();
        await page.waitForFunction(() => window.ApiClient?.isLoggedIn());
        await play(page, movies.TranscodeSample, {subtitleStreamIndex: 1, minimumTime: 1});
        await expectTrack(page, {state: 'active', language: 'jpn', codec: 'subrip'});

        await expect.poll(async () => {
            const [session] = await api(`/Sessions?deviceId=${encodeURIComponent(await page.evaluate(() => window.ApiClient.deviceId()))}`);
            return session?.PlayState?.PlayMethod;
        }, {timeout: 15_000}).toBe('Transcode');
    }

    test('stays in sync through playback and seeks', async ({page}) => {
        test.setTimeout(180_000);
        await startTranscode(page);
        await startRecording(page);
        await page.waitForTimeout(6000);
        for (const target of [30.3, 12.3, 44.3]) {
            await setVideoTime(page, target);
            await page.waitForFunction((time) => {
                const video = document.querySelector('video.htmlvideoplayer');
                return !video.paused && !video.seeking && video.readyState >= 3 && Math.abs(video.currentTime - time) < 3;
            }, target, {timeout: 30_000});
            await page.waitForTimeout(3000);
        }

        const samples = await stopRecording(page);
        const sync = measureSync(samples, syncCues);
        console.log(`transcode: ${sync.frames} frames, ${sync.wrongFrames} wrong, worst ${(sync.worstSeconds * 1000).toFixed(1)} ms`);
        expect(sync.frames).toBeGreaterThan(50);
        expect(sync.worstSeconds).toBeLessThan(0.25);
    });
});

test.describe('nothing leaks', () => {
    test.beforeEach(({page}) => trackEngineTimers(page));

    test('track switches leave the same listeners and timers', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        const video = 'document.querySelector("video.htmlvideoplayer")';
        const before = await countListeners(page, video);

        for (let round = 0; round < 3; round += 1) {
            await setSubtitleTrack(page, TRACKS.english);
            await expectTrack(page, {state: 'inactive', index: TRACKS.english});
            await setSubtitleTrack(page, TRACKS.japanese);
            await expectTrack(page, {state: 'active', index: TRACKS.japanese});
        }

        expect(await countListeners(page, video)).toBe(before);
        expect((await engineTimers(page)).intervals).toBe(1);
        expect(await page.locator('.yomitan-overlay').count()).toBe(1);
    });

    test('leaving the player tears everything down', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        const listenersBefore = {
            window: await countListeners(page, 'window'),
            document: await countListeners(page, 'document'),
        };

        for (let round = 0; round < 3; round += 1) {
            await stopPlayback(page);
            await expect.poll(() => page.evaluate(() => window.__yomitanJellyfin.playback.session)).toBeNull();

            expect(await engineTimers(page)).toEqual({intervals: 0, frames: 0});
            expect(await nativeState(page)).toMatchObject({hiding: false, overlay: false});
            expect(await page.evaluate(() => window.__yomitanJellyfin.playback.engine.cacheSize)).toEqual({terms: 0, rows: 0});
            expect(await page.evaluate(() => window.__yomitanJellyfin.playback._view)).toBeNull();

            if (round < 2) {
                await startJapanese(page);
            }
        }

        expect(await countListeners(page, 'window')).toBeLessThanOrEqual(listenersBefore.window);
        expect(await countListeners(page, 'document')).toBeLessThanOrEqual(listenersBefore.document);
    });

    test('playing again after leaving starts clean, with nothing from before', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        await stopPlayback(page);
        await expect.poll(() => page.evaluate(() => window.__yomitanJellyfin.playback.session)).toBeNull();

        await play(page, movies.TracksSample, {subtitleStreamIndex: TRACKS.english, minimumTime: 1});
        await expectTrack(page, {state: 'inactive', language: 'eng'});
        expect(await nativeState(page)).toMatchObject({hiding: false, overlay: false});
    });
});

test.describe('what Phases 4 and 5 use', () => {
    test('events, the words of the current cue, and a lookup for a word', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        const result = await page.evaluate(() => new Promise((resolve) => {
            const {playback} = window.__yomitanJellyfin;
            const seen = [];
            playback.addEventListener('cuechange', ({detail}) => seen.push(detail.cues.length));
            playback.addEventListener('words', async ({detail: {cue, words}}) => {
                const word = words.find(({text}) => text.length > 1 && text !== 'です');
                const {dictionaryEntries, originalTextLength, truncated} = await playback.engine.lookup(word.text);
                resolve({
                    seen,
                    matches: word.text === cue.text.slice(word.start, word.end),
                    headword: dictionaryEntries[0]?.headwords[0].term,
                    originalTextLength,
                    truncated,
                    length: word.text.length,
                    stored: playback.session.words.get(cue.id) === words,
                    time: playback.session.time,
                });
            });

            // A line far ahead, so its words are not ready yet.
            const manager = playback.playbackManager;
            manager.seek(46.2 * 1e7, manager.getCurrentPlayer());
        }));
        expect(result.seen.at(-1)).toBeGreaterThan(0);
        expect(result.matches).toBe(true);
        expect(result.headword).toBeTruthy();
        expect(result.originalTextLength).toBe(result.length);
        expect(result.truncated).toBe(false);
        expect(result.stored).toBe(true);
        expect(result.time).toBeGreaterThan(45);
    });

    test('a lookup renders through Yomitan\'s own DisplayGenerator', async ({page}) => {
        await logIn(page);
        await startJapanese(page);
        await page.addScriptTag({content: await bundleYomitan()});
        const templates = readFileSync(new URL('../../third_party/yomitan/ext/templates-display.html', import.meta.url), 'utf8');
        const rendered = await page.evaluate(async (html) => {
            const {engine} = window.__yomitanJellyfin.playback;
            const {DisplayGenerator} = window.yomitan;
            const content = {loadMedia() {}, prepareLink() {}, unloadAll() {}};
            const generator = new DisplayGenerator(content, null);
            generator._templates.load(new DOMParser().parseFromString(html, 'text/html'));
            const {dictionaryEntries} = await engine.lookup('食べられなかった');
            const node = generator.createTermEntry(dictionaryEntries[0], engine.dictionaries);
            return {
                expression: node.querySelector('.headword-term').textContent,
                gloss: node.querySelector('.gloss-content').textContent,
                inflections: node.querySelectorAll('.inflection').length,
            };
        }, templates);
        // With its furigana, which is in the text as ruby.
        expect(rendered.expression).toBe('食たべる');
        expect(rendered.gloss).toBe('meaning of 食べる');
        expect(rendered.inflections).toBeGreaterThan(0);
    });
});
