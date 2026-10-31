// Helpers for the playback specs. Everything reads the real page: the DOM, the video element, and jellyfin-web's own
// playbackManager, which is what its UI calls.
import {readFileSync} from 'node:fs';
import {expect} from '@playwright/test';

/** Parses an SRT fixture, so the specs check the client against the file and not against itself. */
export function readSrt(name) {
    const seconds = (text) => {
        const [hours, minutes, rest] = text.split(':');
        return Number(hours) * 3600 + Number(minutes) * 60 + Number(rest.replace(',', '.'));
    };

    return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
        .trim()
        .split(/\n\n+/)
        .map((block) => {
            const [, timing, ...text] = block.split('\n');
            const [start, end] = timing.split(' --> ').map(seconds);
            return {start, end, text: text.join('\n')};
        });
}

/** The cue a file says is showing at `time`, or an empty string. */
export function cueTextAt(cues, time) {
    return cues.find(({start, end}) => start <= time && time < end)?.text ?? '';
}

/** Waits for the plugin to settle on a track, and asserts which one, since a wrong track makes every later check moot. */
export async function expectTrack(page, {state, language, codec, index}) {
    await page.waitForFunction((expected) => window.__yomitanJellyfin.playback?.session?.state === expected, state, {timeout: 20_000});
    const stream = await page.evaluate(() => {
        const {Language, Codec, Index} = window.__yomitanJellyfin.playback.session.stream;
        return {language: Language, codec: Codec, index: Index};
    });
    if (language !== undefined) {
        expect(stream.language).toBe(language);
    }

    if (codec !== undefined) {
        expect(stream.codec.toLowerCase()).toBe(codec);
    }

    if (index !== undefined) {
        expect(stream.index).toBe(index);
    }

    return stream;
}

/** What is on screen now. */
export function overlayText(page) {
    return page.evaluate(() => [...document.querySelectorAll('.yomitan-lines .yomitan-line')].map((line) => line.textContent).join('\n'));
}

export function signText(page) {
    return page.evaluate(() => [...document.querySelectorAll('.yomitan-signs .yomitan-line')].map((line) => line.textContent).join('\n'));
}

/** Word spans of the line on screen. */
export function overlayWords(page) {
    return page.evaluate(() => [...document.querySelectorAll('.yomitan-lines .yomitan-word')].map(({textContent, dataset}) => ({
        text: textContent,
        start: Number(dataset.start),
        end: Number(dataset.end),
    })));
}

/** The state of Jellyfin's own subtitles and of the plugin's hold on them. */
export function nativeState(page) {
    return page.evaluate(() => {
        const video = document.querySelector('video.htmlvideoplayer');
        return {
            hiding: document.documentElement.hasAttribute('data-yomitan-hides-subtitles'),
            overlay: document.querySelector('.yomitan-overlay') !== null,
            tracks: [...(video?.textTracks ?? [])].map(({mode, label, cues}) => ({mode, label, cues: cues?.length ?? 0})),
        };
    });
}

export function setVideoTime(page, time) {
    return page.evaluate((target) => {
        const manager = window.__yomitanJellyfin.playback.playbackManager;
        manager.seek(Math.round(target * 1e7), manager.getCurrentPlayer());
    }, time);
}

/** Selects a subtitle track, as the player's menu does. -1 turns subtitles off. */
export function setSubtitleTrack(page, index) {
    return page.evaluate((target) => {
        const manager = window.__yomitanJellyfin.playback.playbackManager;
        manager.setSubtitleStreamIndex(target, manager.getCurrentPlayer());
    }, index);
}

export function setSecondaryTrack(page, index) {
    return page.evaluate((target) => {
        const manager = window.__yomitanJellyfin.playback.playbackManager;
        manager.setSecondarySubtitleStreamIndex(target, manager.getCurrentPlayer());
    }, index);
}

/** Sets the offset, as the subtitle sync slider does. */
export function setSubtitleOffset(page, offset) {
    return page.evaluate((value) => {
        const manager = window.__yomitanJellyfin.playback.playbackManager;
        manager.setSubtitleOffset(value, manager.getCurrentPlayer());
    }, offset);
}

export function stopPlayback(page) {
    return page.evaluate(() => {
        const manager = window.__yomitanJellyfin.playback.playbackManager;
        return manager.stop(manager.getCurrentPlayer());
    });
}

/**
 * Starts recording in the page: for every frame, the video's time and the text on screen.
 * @returns {Promise<void>}
 */
export function startRecording(page) {
    return page.evaluate(() => {
        const video = document.querySelector('video.htmlvideoplayer');
        const samples = [];
        window.syncRecording = {samples, running: true};
        const sample = () => {
            if (!window.syncRecording?.running) {
                return;
            }

            const text = [...document.querySelectorAll('.yomitan-lines .yomitan-line')].map((line) => line.textContent).join('\n');
            samples.push({time: video.currentTime, text, seeking: video.seeking, paused: video.paused});
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    });
}

/** @returns {Promise<{time: number, text: string, seeking: boolean, paused: boolean}[]>} */
export function stopRecording(page) {
    return page.evaluate(() => {
        window.syncRecording.running = false;
        return window.syncRecording.samples;
    });
}

/**
 * Compares a recording with the file. A frame is wrong if its text is not what the file has at its time, and how wrong
 * is how far that time is from where the right text would have been showing.
 * @param {object[]} samples From stopRecording.
 * @param {object[]} cues From readSrt.
 * @param {(time: number) => number} [toFileTime] Maps video time to the file, for an offset.
 * @returns {{frames: number, worstSeconds: number, wrongFrames: number}}
 */
export function measureSync(samples, cues, toFileTime = (time) => time) {
    const distanceToEdge = (time) => Math.min(...cues.flatMap(({start, end}) => [Math.abs(time - start), Math.abs(time - end)]));
    let worstSeconds = 0;
    let wrongFrames = 0;
    let frames = 0;
    for (const {time, text, seeking} of samples) {
        if (seeking) {
            continue;
        }

        frames += 1;
        const fileTime = toFileTime(time);
        if (text !== cueTextAt(cues, fileTime)) {
            wrongFrames += 1;
            worstSeconds = Math.max(worstSeconds, distanceToEdge(fileTime));
        }
    }

    return {frames, worstSeconds, wrongFrames};
}

/** Counts the listeners on an object in the page, through the debugger, which is the only honest count. Chromium only. */
export async function countListeners(page, expression) {
    const session = await page.context().newCDPSession(page);
    const {result: {objectId}} = await session.send('Runtime.evaluate', {expression});
    const {listeners} = await session.send('DOMDebugger.getEventListeners', {objectId});
    await session.detach();
    return listeners.length;
}

/** Records every timer the engine script starts. Install before the page loads. */
export function trackEngineTimers(page) {
    return page.addInitScript(() => {
        const live = {intervals: new Set(), frames: new Set()};
        window.engineTimers = live;
        const fromEngine = () => new Error('where').stack.includes('engine.js');

        const {setInterval: startInterval, clearInterval: endInterval, requestAnimationFrame: startFrame, cancelAnimationFrame: endFrame} = window;
        window.setInterval = function (...args) {
            const id = startInterval.apply(this, args);
            if (fromEngine()) {
                live.intervals.add(id);
            }

            return id;
        };
        window.clearInterval = function (id) {
            live.intervals.delete(id);
            return endInterval.call(this, id);
        };
        window.requestAnimationFrame = function (callback) {
            let id = 0;
            const engine = fromEngine();
            id = startFrame.call(this, (time) => {
                live.frames.delete(id);
                callback(time);
            });
            if (engine) {
                live.frames.add(id);
            }

            return id;
        };
        window.cancelAnimationFrame = function (id) {
            live.frames.delete(id);
            return endFrame.call(this, id);
        };
    });
}

export function engineTimers(page) {
    return page.evaluate(() => ({intervals: window.engineTimers.intervals.size, frames: window.engineTimers.frames.size}));
}
