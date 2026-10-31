// The exit check, on real material that is not in the repository. Two inputs, each optional:
//
//   YOMITAN_REAL_SUBTITLES   a directory of .srt files. Measures requests and time per line over each whole file.
//   JF_EXTRA_MEDIA           a directory holding Movies/<title>/ with a video and subtitles, mounted by scripts/dev.sh.
//                            With YOMITAN_REAL_FILM naming a title, plays it for real and measures sync. Give
//                            YOMITAN_REAL_SRT the same file the server has to check the cues against it, too. Also
//                            YOMITAN_REAL_CODEC, _RATE, _SECONDS, _SEEKS (seconds, comma-separated), _SWITCH_TO (a
//                            codec) and _TRANSCODE=1, which forces a transcode with a low bitrate.
//
// Both need real dictionaries installed, from YOMITAN_REAL_DICTS.
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {openEngine} from '../lib/engine-page.mjs';
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {api, credentials, logIn, play} from '../lib/jellyfin.mjs';
import {expect, test} from '../lib/test.mjs';
import {
    expectTrack, nativeState, parseSrt, setSubtitleTrack, setVideoTime, startRecording, stopRecording,
} from '../lib/player.mjs';

const subtitles = process.env.YOMITAN_REAL_SUBTITLES;
const dictionaries = process.env.YOMITAN_REAL_DICTS;
const film = process.env.YOMITAN_REAL_FILM;
const filmCodec = process.env.YOMITAN_REAL_CODEC ?? 'subrip';
const filmRate = Number(process.env.YOMITAN_REAL_RATE ?? 1);
const filmSeconds = Number(process.env.YOMITAN_REAL_SECONDS ?? 120);

test.skip(!dictionaries || (!subtitles && !film), 'Needs YOMITAN_REAL_DICTS, and YOMITAN_REAL_SUBTITLES or YOMITAN_REAL_FILM');
test.describe.configure({timeout: 3_600_000});

test.beforeAll(async () => {
    test.setTimeout(600_000);
    const admin = await clientFor(credentials.username, credentials.password);
    const {dictionaries: installed} = await (await admin.list()).json();
    if (installed.length !== 3) {
        await deleteAll(admin);
        for (const file of ['JMdict_english.zip', 'JMnedict.zip', 'KANJIDIC_english.zip']) {
            expect((await importArchive(admin, readFileSync(join(dictionaries, file)))).state).toBe('succeeded');
        }
    }
});

const percentile = (values, share) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * share))];

function srtLines(path) {
    return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() && !/^\d+$/.test(line.trim()) && !line.includes('-->'));
}

for (const file of subtitles ? readdirSync(subtitles).filter((name) => name.endsWith('.srt')).sort() : []) {
    test(`requests and time per line, ${file}`, async ({page}) => {
        const lines = srtLines(join(subtitles, file));
        const bodies = [];
        page.on('requestfinished', async (request) => {
            if (request.url().endsWith('/Yomitan/Query')) {
                bodies.push((await request.sizes()).responseBodySize);
            }
        });

        await openEngine(page);
        const results = await page.evaluate(async (texts) => {
            const output = [];
            for (const text of texts) {
                const requests = window.engine.requests;
                const started = performance.now();
                const words = await window.segmenter.segment(text);
                output.push({ms: performance.now() - started, requests: window.engine.requests - requests, words: words.length});
            }

            return output;
        }, lines);

        // Lines in order, with what earlier lines already cached, as in playback. Repeats of a line are the cached case.
        const fresh = results.filter(({requests}) => requests > 0);
        const zero = results.filter(({requests}) => requests === 0);
        const report = {
            lines: results.length,
            requestsMedian: percentile(results.map(({requests}) => requests), 0.5),
            requestsP95: percentile(results.map(({requests}) => requests), 0.95),
            requestsMax: Math.max(...results.map(({requests}) => requests)),
            noRequest: zero.length,
            msMedian: Math.round(percentile(results.map(({ms}) => ms), 0.5)),
            msP95: Math.round(percentile(results.map(({ms}) => ms), 0.95)),
            msMax: Math.round(Math.max(...results.map(({ms}) => ms))),
            msMedianWithRequest: fresh.length ? Math.round(percentile(fresh.map(({ms}) => ms), 0.5)) : 0,
            wireKbMedian: Math.round(percentile(bodies, 0.5) / 1024),
            wireKbP95: Math.round(percentile(bodies, 0.95) / 1024),
            heapMb: await page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1e6)),
        };
        console.log(`${file}: ${JSON.stringify(report)}`);
        expect(report.requestsMax).toBeLessThanOrEqual(2);

        const repeat = await page.evaluate(async (texts) => {
            const before = window.engine.requests;
            for (const text of texts) {
                await window.segmenter.segment(text);
            }

            return window.engine.requests - before;
        }, lines);
        expect(repeat).toBe(0);
    });
}

function compareWithCues(samples, cues) {
    const dialogue = cues.filter(({kind}) => kind === 'dialogue');
    const expectedAt = (time) => dialogue.filter(({start, end}) => start <= time && time < end).map(({text}) => text).sort().join('|');
    const shown = (text) => text.split('\n').sort().join('|');
    const flatten = (text) => text.replaceAll('\n', '');
    let worst = 0;
    let wrong = 0;
    let frames = 0;
    for (const {time, text, seeking} of samples) {
        if (seeking) {
            continue;
        }

        frames += 1;
        if (flatten(shown(text)) !== flatten(expectedAt(time))) {
            wrong += 1;
            worst = Math.max(worst, Math.min(...dialogue.flatMap(({start, end}) => [Math.abs(time - start), Math.abs(time - end)])));
        }
    }

    return {frames, wrong, worst};
}

const clientCues = (page) => page.evaluate(() => window.__yomitanJellyfin.playback.session._timeline.cues.map(({start, end, text, kind}) => ({start, end, text, kind})));

const report = (label, {frames, wrong, worst}) => console.log(`${film}, ${label}: ${frames} frames, ${wrong} wrong, worst ${(worst * 1000).toFixed(1)} ms`);

test('a real film plays with the overlay in sync with its own subtitles', async ({page}) => {
    test.skip(!film, 'Needs YOMITAN_REAL_FILM');
    await logIn(page);
    const transcode = process.env.YOMITAN_REAL_TRANSCODE === '1';
    if (transcode) {
        await page.evaluate(() => {
            localStorage.setItem('maxbitrate-Video-true', '120000');
            localStorage.setItem('maxbitrate-Video-false', '120000');
        });
        await page.reload();
        await page.waitForFunction(() => window.ApiClient?.isLoggedIn());
    }

    const [user] = await api('/Users');
    const {Items: items} = await api(`/Items?userId=${user.Id}&recursive=true&includeItemTypes=Movie&searchTerm=${encodeURIComponent(film)}`);
    expect(items.length).toBe(1);
    const {MediaStreams: streams} = (await api(`/Items/${items[0].Id}/PlaybackInfo?userId=${user.Id}`)).MediaSources[0];
    const findTrack = (codec) => streams.find(({Type, Codec}) => Type === 'Subtitle' && Codec.toLowerCase() === codec);
    const stream = findTrack(filmCodec);
    expect(stream, `no ${filmCodec} track`).toBeTruthy();

    await play(page, items[0].Id, {subtitleStreamIndex: stream.Index, minimumTime: 0.5});
    await expectTrack(page, {state: 'active', language: 'jpn', codec: filmCodec, index: stream.Index});
    expect((await nativeState(page)).overlay).toBe(true);

    const deviceId = await page.evaluate(() => window.ApiClient.deviceId());
    await expect.poll(async () => (await api(`/Sessions?deviceId=${encodeURIComponent(deviceId)}`))[0]?.PlayState?.PlayMethod, {timeout: 20_000})
        .toBe(transcode ? 'Transcode' : 'DirectPlay');

    await page.evaluate((rate) => {
        document.querySelector('video.htmlvideoplayer').playbackRate = rate;
        window.longTasks = [];
        new PerformanceObserver((list) => {
            window.longTasks.push(...list.getEntries().map(({duration}) => Math.round(duration)));
        }).observe({entryTypes: ['longtask']});
    }, filmRate);

    const cues = await clientCues(page);
    console.log(`${film}: ${cues.length} cues, ${cues.filter(({kind}) => kind === 'sign').length} signs`);
    if (process.env.YOMITAN_REAL_SRT) {
        const flatten = (text) => text.replace(/\s+/g, '');
        const fromFile = parseSrt(readFileSync(process.env.YOMITAN_REAL_SRT, 'utf8').replace(/\r/g, ''));
        const key = ({start, text}) => `${start.toFixed(2)} ${flatten(text)}`;
        const shownKeys = new Set(cues.map(key));
        const missing = fromFile.filter((cue) => flatten(cue.text) && !shownKeys.has(key(cue)));
        console.log(`${film}: ${fromFile.length} cues in the file, ${missing.length} missing from the client's`);
        expect(missing).toEqual([]);
    }

    await startRecording(page);
    const seeks = (process.env.YOMITAN_REAL_SEEKS ?? '').split(',').filter(Boolean).map(Number);
    for (const target of seeks) {
        await setVideoTime(page, target);
        await page.waitForFunction((time) => {
            const video = document.querySelector('video.htmlvideoplayer');
            return !video.seeking && !video.paused && video.readyState >= 3 && Math.abs(video.currentTime - time) < 5;
        }, target, {timeout: 60_000});
        await page.waitForTimeout(filmSeconds * 1000 / seeks.length);
    }

    if (seeks.length === 0) {
        await page.waitForTimeout(filmSeconds * 1000);
    }

    const sync = compareWithCues(await stopRecording(page), cues);
    report(`${transcode ? 'transcode' : 'direct play'} at ${filmRate}x${seeks.length ? ` through ${seeks.length} seeks` : ''}`, sync);
    expect(sync.frames).toBeGreaterThan(100);
    expect(sync.worst).toBeLessThan(0.15 * Math.max(1, filmRate));

    const {timings, played, longTasks, heap} = await page.evaluate(() => {
        const {session} = window.__yomitanJellyfin.playback;
        return {
            timings: session.timings,
            played: document.querySelector('video.htmlvideoplayer').currentTime,
            longTasks: window.longTasks,
            heap: performance.memory.usedJSHeapSize,
        };
    });
    const ready = timings.filter((timing) => timing.ready).length;
    const late = timings.filter(({ready: wasReady}) => !wasReady).map(({lateMs}) => lateMs ?? 0);
    console.log(`${film}: played to ${played.toFixed(0)} s, ${longTasks.length} long tasks, worst ${Math.max(0, ...longTasks)} ms, heap ${Math.round(heap / 1e6)} MB`);
    console.log(`${film}: ${ready} of ${timings.length} cues had their words before they showed. Late ones: median ${late.length ? Math.round(percentile(late, 0.5)) : 0} ms, p95 ${late.length ? Math.round(percentile(late, 0.95)) : 0} ms, worst ${late.length ? Math.round(Math.max(...late)) : 0} ms`);

    const other = process.env.YOMITAN_REAL_SWITCH_TO;
    if (other) {
        await setSubtitleTrack(page, findTrack(other).Index);
        await expectTrack(page, {state: 'active', codec: other, index: findTrack(other).Index});
        const afterSwitch = await clientCues(page);
        await startRecording(page);
        await page.waitForTimeout(30_000);
        const switched = compareWithCues(await stopRecording(page), afterSwitch);
        report(`after switching to ${other}`, switched);
        expect(switched.worst).toBeLessThan(0.15 * Math.max(1, filmRate));
    }
});
