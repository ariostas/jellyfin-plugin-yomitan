// Helpers for the specs that use the keyboard. Keys go in as real input, through the browser and not through the page.
import {expect} from '@playwright/test';
import {activeWord, expectPopup, osdShowing, parkMouse, pauseVideo, videoState} from './lookup.mjs';
import {setVideoTime} from './player.mjs';

/** What a remote's keys send, for the ones Playwright's keyboard has no name for. See pressCode. */
export const REMOTE_KEYS = {
    webOsBack: {keyCode: 461},
    tizenBack: {keyCode: 10009},
    browserBack: {keyCode: 166, key: 'BrowserBack', code: 'BrowserBack'},
    goBack: {keyCode: 0, key: 'GoBack'},
};

/** The Display mode setting's value in localStorage, read when the page loads. `spec/keys` also selects it in the UI. */
export function useTvLayout(page) {
    return page.addInitScript(() => localStorage.setItem('layout', 'tv'));
}

/**
 * Presses a key by code, through the browser's own input path, which is also what page.keyboard uses. It needs Chromium's
 * debugger. Playwright's keyboard only has the keys of a US keyboard.
 */
export async function pressCode(page, {keyCode, key = '', code = ''}) {
    const session = await page.context().newCDPSession(page);
    const event = {windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, key, code};
    await session.send('Input.dispatchKeyEvent', {type: 'rawKeyDown', ...event});
    await session.send('Input.dispatchKeyEvent', {type: 'keyUp', ...event});
    await session.detach();
}

export function inWordMode(page) {
    return page.evaluate(() => document.querySelector('.yomitan-word-mode') !== null);
}

/** Waits for the cursor to be on a word with its popup showing. `term` is the headword, for an inflected word. */
export async function expectCursor(page, word, term = word) {
    await expect.poll(() => activeWord(page), {message: `the cursor on ${word}`}).toBe(word);
    await expectPopup(page, term);
    expect(await inWordMode(page)).toBe(true);
}

/** Word mode has ended, with nothing of it left on screen. */
export async function expectLeft(page) {
    await expect.poll(() => inWordMode(page)).toBe(false);
    await expect.poll(() => activeWord(page)).toBeNull();
}

export function setEnabled(page, enabled) {
    return page.evaluate((value) => window.__yomitanJellyfin.settings.set('enabled', value), enabled);
}

export function setUpOnly(page, value) {
    return page.evaluate((upOnly) => window.__yomitanJellyfin.settings.set('upOnlyEntry', upOnly), value);
}

export function waitForActive(page) {
    return page.waitForFunction(() => window.__yomitanJellyfin.playback.session?.state === 'active');
}

/** Whatever jellyfin-web's keys can change, for comparing what a key did with and without the plugin. */
export async function jellyfinState(page) {
    const {paused, time, volume} = await videoState(page);
    const shown = await page.evaluate(() => {
        const active = document.activeElement;
        return {
            hash: location.hash.split('?')[0],
            dialogs: document.querySelectorAll('.dialogContainer .dialog.opened').length,
            focus: active === document.body ? 'body' : `${active.tagName} ${active.className} ${active.textContent.slice(0, 20)}`,
            caret: getSelection()?.focusOffset ?? 0,
        };
    });
    return {paused, time, volume, osd: await osdShowing(page), ...shown};
}

let wiggle = 0;

/** Shows the OSD, as moving the mouse does. */
async function showOsd(page) {
    wiggle += 1;
    await parkMouse(page);
    await page.mouse.move(40 + (wiggle % 2) * 40, 200, {steps: 2});
    await expect.poll(() => osdShowing(page)).toBe(true);
}

/** Hides the OSD with a real Escape, which is only safe while it is showing. */
async function hideOsdIfShown(page) {
    if (await osdShowing(page)) {
        await page.keyboard.press('Escape');
        await expect.poll(() => osdShowing(page)).toBe(false);
    }
}

/** Closes jellyfin-web's dialogs, whichever are open. Each is a step in its history. */
async function closeDialogs(page) {
    const open = () => page.locator('.dialogContainer .dialog.opened').count();
    while (await open() > 0) {
        const before = await open();
        await page.evaluate(() => history.back());
        await expect.poll(open).toBeLessThan(before);
    }
}

const settled = (page) => page.waitForFunction(() => {
    const video = document.querySelector('video.htmlvideoplayer');
    return !video.seeking && video.readyState >= 2;
});

/**
 * Puts the player in a known state.
 * @param {import('@playwright/test').Page} page
 * @param {object} state
 * @param {number} state.at The time to seek to.
 * @param {boolean} state.paused
 * @param {boolean} [state.osd] Whether the OSD shows. Hidden otherwise.
 */
export async function setPlayer(page, {at, paused, osd = false}) {
    await closeDialogs(page);
    await page.evaluate(() => document.activeElement?.blur());
    await page.evaluate(async () => {
        const manager = window.__yomitanJellyfin.playback.playbackManager;
        manager.setVolume(50, manager.getCurrentPlayer());
        await document.querySelector('video.htmlvideoplayer').play();
    });
    await setVideoTime(page, at);
    await expect.poll(async () => {
        const {time} = await videoState(page);
        return Math.abs(time - at) < 2;
    }).toBe(true);
    await settled(page);
    if (paused) {
        await pauseVideo(page);
    }

    await (osd ? showOsd(page) : hideOsdIfShown(page));
}

/**
 * Presses a key and says what came of it. Time is only which way it jumped, because a playing video moves on and jellyfin-web's
 * shortest seek is 10 s. The other fields settle, so they are polled until they stop changing.
 * @param {import('@playwright/test').Page} page
 * @param {string} key
 * @param {object} [options]
 * @param {number} [options.after] Milliseconds to wait, for a key that acts late, as a slider does.
 */
export async function effectOf(page, key, {after = 0} = {}) {
    const before = await videoState(page);
    await page.keyboard.press(key);
    await page.waitForTimeout(after);
    let last = null;
    let same = 0;
    await expect.poll(async () => {
        const {time, ...rest} = await jellyfinState(page);
        const text = JSON.stringify(rest);
        same = text === last ? same + 1 : 0;
        last = text;
        return same;
    }, {intervals: [150]}).toBeGreaterThanOrEqual(3);
    await settled(page);
    const {time, ...state} = await jellyfinState(page);
    const moved = time - before.time;
    return {key, ...state, moved: Math.abs(moved) < 6 ? 0 : Math.sign(moved)};
}
