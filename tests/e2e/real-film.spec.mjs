// The exit check, on real material that is not in the repository. Two inputs, each optional:
//
//   YOMITAN_REAL_SUBTITLES   a directory of .srt files. Measures requests and time per line over each whole file.
//   JF_EXTRA_MEDIA           a directory holding Movies/<title>/ with a video and subtitles, mounted by scripts/dev.sh.
//                            With YOMITAN_REAL_FILM naming a title, plays it for real and measures sync.
//
// Both need real dictionaries installed, from YOMITAN_REAL_DICTS.
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from '@playwright/test';
import {openEngine} from '../lib/engine-page.mjs';
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {api, credentials, logIn, play} from '../lib/jellyfin.mjs';
import {expectTrack, nativeState, setVideoTime, startRecording, stopRecording} from '../lib/player.mjs';

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

test('a real film plays with the overlay in sync with its own subtitles', async ({page}) => {
    test.skip(!film, 'Needs YOMITAN_REAL_FILM');
    await logIn(page);
    const [user] = await api('/Users');
    const {Items: items} = await api(`/Items?userId=${user.Id}&recursive=true&includeItemTypes=Movie&searchTerm=${encodeURIComponent(film)}`);
    expect(items.length).toBe(1);
    const {MediaStreams: streams} = (await api(`/Items/${items[0].Id}/PlaybackInfo?userId=${user.Id}`)).MediaSources[0];
    const stream = streams.find(({Type, Codec}) => Type === 'Subtitle' && Codec.toLowerCase() === filmCodec);
    expect(stream, `no ${filmCodec} track`).toBeTruthy();

    await play(page, items[0].Id, {subtitleStreamIndex: stream.Index, minimumTime: 0.5});
    await expectTrack(page, {state: 'active', language: 'jpn', codec: filmCodec, index: stream.Index});
    expect((await nativeState(page)).overlay).toBe(true);

    // The client's own cues are what the overlay should show, so compare it with them frame by frame. The cues are
    // checked against the file separately, by a person, for a sample: see the report.
    await page.evaluate((rate) => {
        document.querySelector('video.htmlvideoplayer').playbackRate = rate;
    }, filmRate);
    const cues = await page.evaluate(() => window.__yomitanJellyfin.playback.session._timeline.cues.map(({start, end, text, kind}) => ({start, end, text, kind})));
    console.log(`${film}: ${cues.length} cues, ${cues.filter(({kind}) => kind === 'sign').length} signs`);

    await page.evaluate(() => {
        window.longTasks = [];
        new PerformanceObserver((list) => {
            window.longTasks.push(...list.getEntries().map(({duration}) => Math.round(duration)));
        }).observe({entryTypes: ['longtask']});
    });

    await startRecording(page);
    const start = process.env.YOMITAN_REAL_START;
    if (start) {
        await setVideoTime(page, Number(start));
    }

    await page.waitForTimeout(filmSeconds * 1000);
    const samples = await stopRecording(page);

    const dialogue = cues.filter(({kind}) => kind === 'dialogue');
    const expectedAt = (time) => dialogue.filter(({start: from, end}) => from <= time && time < end).map(({text}) => text.replaceAll('\n', '')).sort().join('|');
    const shown = (text) => text.split('\n').sort().join('|');
    let worst = 0;
    let wrong = 0;
    let frames = 0;
    for (const {time, text, seeking} of samples) {
        if (seeking) {
            continue;
        }

        frames += 1;
        if (shown(text) !== expectedAt(time)) {
            wrong += 1;
            const distance = Math.min(...dialogue.flatMap(({start: from, end}) => [Math.abs(time - from), Math.abs(time - end)]));
            worst = Math.max(worst, distance);
        }
    }

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
    console.log(`${film}: played to ${played.toFixed(0)} s at ${filmRate}x, ${frames} frames, ${wrong} wrong, worst ${(worst * 1000).toFixed(1)} ms`);
    console.log(`${film}: ${longTasks.length} long tasks, worst ${Math.max(0, ...longTasks)} ms, heap ${Math.round(heap / 1e6)} MB`);
    console.log(`${film}: ${ready} of ${timings.length} cues had their words before they showed. Late ones: median ${late.length ? Math.round(percentile(late, 0.5)) : 0} ms, worst ${late.length ? Math.round(Math.max(...late)) : 0} ms`);
    expect(frames).toBeGreaterThan(100);
    expect(worst).toBeLessThan(0.15 * Math.max(1, filmRate));
});
