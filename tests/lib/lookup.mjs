// Helpers for the specs that use a word: real pointer input through the page, and what really happened to the video.
import {expect} from '@playwright/test';
import {api, getMovies, play} from './jellyfin.mjs';
import {expectTrack, setVideoTime} from './player.mjs';

/** The Japanese track of LookupSample. External subtitles sort first, and this is the only one. */
export const LOOKUP_TRACK = 0;

/** Lines of tests/fixtures/lookup.ja.srt, by when they show. `at` is well inside each. */
export const LINES = {
    plain: {at: 1, words: ['昨日', 'は', '学校', 'に', '行きませんでした']},
    unknown: {at: 11, words: ['ほげほげ', 'は', '猫', 'です']},
    twoLines: {at: 21},
    special: {at: 31},
    coffee: {at: 41, words: ['彼女', 'は', 'コーヒー', 'を', '飲みます']},
    long: {at: 51},
};

const videoSelector = 'video.htmlvideoplayer';

/** Starts the lookup film with its Japanese track and waits for the overlay. */
export async function startLookupFilm(page, {minimumTime = 0.2} = {}) {
    const {LookupSample: item} = await getMovies();
    const sessionId = await play(page, item, {subtitleStreamIndex: LOOKUP_TRACK, minimumTime});
    await expectTrack(page, {state: 'active', language: 'jpn'});
    return sessionId;
}

/**
 * Seeks to a line and waits for its words.
 * @param {import('@playwright/test').Page} page
 * @param {{at: number}} line
 */
export async function showLine(page, {at}) {
    await setVideoTime(page, at);
    await page.waitForFunction((time) => {
        const video = document.querySelector('video.htmlvideoplayer');
        return video && !video.seeking && Math.abs(video.currentTime - time) < 5 && document.querySelector('.yomitan-word');
    }, at);
    // Seeking closes things, and the line can still be settling, so nothing should be underway when this returns.
    await page.waitForFunction(() => window.__yomitanJellyfin.playback.session.cues.length > 0);
}

export function videoState(page) {
    return page.evaluate((selector) => {
        const video = document.querySelector(selector);
        return {paused: video.paused, time: video.currentTime, volume: video.volume};
    }, videoSelector);
}

export const isPaused = (page) => videoState(page).then(({paused}) => paused);

export function pauseVideo(page) {
    return page.evaluate((selector) => document.querySelector(selector).pause(), videoSelector);
}

/** What the server believes, which is what other clients and the dashboard see. */
export async function serverPaused(sessionId) {
    const sessions = await api('/Sessions');
    return sessions.find(({Id}) => Id === sessionId)?.PlayState?.IsPaused;
}

/** The middle of a word on screen, found by its text. */
export async function wordCentre(page, text, {occurrence = 0} = {}) {
    const box = await page.evaluate(([word, nth]) => {
        const span = [...document.querySelectorAll('.yomitan-word')].filter(({textContent}) => textContent === word)[nth];
        if (!span) {
            return null;
        }

        const {left, top, width, height} = span.getBoundingClientRect();
        return {left, top, width, height};
    }, [text, occurrence]);
    expect(box, `the word ${text} is on screen`).not.toBeNull();
    return {x: box.left + box.width / 2, y: box.top + box.height / 2, ...box};
}

/** Moves the real mouse onto a word, in a few steps, and leaves it there. */
export async function moveToWord(page, text, options) {
    const {x, y} = await wordCentre(page, text, options);
    await page.mouse.move(x, y, {steps: 4});
    return {x, y};
}

/** Parks the mouse away from everything, and clear of the bottom of the screen. */
export async function parkMouse(page) {
    await page.mouse.move(3, 200, {steps: 2});
}

/** Everything about the popup that a spec checks, from inside its shadow root. */
export function popupState(page) {
    return page.evaluate(() => {
        const host = document.querySelector('.yomitan-popup');
        if (!host || host.hidden) {
            return {open: false};
        }

        const frame = host.shadowRoot.querySelector('.popup-frame');
        const scroll = host.shadowRoot.querySelector('.popup-scroll');
        const rect = frame.getBoundingClientRect();
        const {left, top, right, bottom, width, height} = rect;
        return {
            open: true,
            box: {left, top, right, bottom, width, height},
            side: host.dataset.side,
            scrollTop: scroll.scrollTop,
            scrollHeight: scroll.scrollHeight,
            clientHeight: scroll.clientHeight,
            // Furigana is in the text as ruby, which would otherwise read 行いく.
            headwords: [...scroll.querySelectorAll('.entry[data-type=term] .headword-term')].map((node) => {
                const copy = node.cloneNode(true);
                copy.querySelectorAll('rt').forEach((reading) => reading.remove());
                return copy.textContent;
            }),
            text: scroll.textContent,
        };
    });
}

export async function expectPopup(page, term) {
    await expect.poll(async () => (await popupState(page)).headwords?.some((word) => word.includes(term)) ?? false, {
        message: `a popup for ${term}`,
    }).toBe(true);
}

export async function expectNoPopup(page) {
    await expect.poll(async () => (await popupState(page)).open).toBe(false);
}

export function activeWord(page) {
    return page.evaluate(() => document.querySelector('.yomitan-active')?.textContent ?? null);
}

/** Whether jellyfin-web's OSD is showing. */
export function osdShowing(page) {
    return page.evaluate(() => {
        const bar = document.querySelector('.page:not(.hide) .videoOsdBottom');
        return bar !== null && !bar.classList.contains('hide') && !bar.classList.contains('videoOsdBottom-hidden');
    });
}

/** Waits for jellyfin-web to hide the OSD by itself, which takes 3 s without input. */
export async function waitForOsdHidden(page) {
    await expect.poll(() => osdShowing(page), {timeout: 8000}).toBe(false);
}

/** Counts the video's pause and play events from now on, so a brief pause cannot pass unseen. */
export function countPlayState(page) {
    return page.evaluate((selector) => {
        const video = document.querySelector(selector);
        const counts = {pause: 0, play: 0};
        window.playStateCounts = counts;
        video.addEventListener('pause', () => {
            counts.pause += 1;
        });
        video.addEventListener('play', () => {
            counts.play += 1;
        });
    }, videoSelector);
}

export const playStateCounts = (page) => page.evaluate(() => window.playStateCounts);
