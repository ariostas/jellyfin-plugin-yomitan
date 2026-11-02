// A finger, in real playback, with Chromium's touch input: a phone's viewport and user agent, and jellyfin-web in its
// mobile layout. This is emulation, and says nothing about a real phone. README.md lists what only a phone can show.
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {credentials, logIn} from '../lib/jellyfin.mjs';
import {
    activeWord, countPlayState, expectNoPopup, expectPopup, isPaused, LINES, osdShowing, pauseVideo, playStateCounts, popupState,
    serverPaused, showLine, startLookupFilm, waitForOsdHidden, wordCentre,
} from '../lib/lookup.mjs';
import {makeMiniDictionary} from '../lib/mini-dictionary.mjs';
import {expect, test} from '../lib/test.mjs';

test.describe.configure({timeout: 120_000});
test.skip(({hasTouch}) => !hasTouch, 'Needs a touch screen. See hover.spec.mjs for the mouse.');

let admin;

test.beforeAll(async () => {
    admin = await clientFor(credentials.username, credentials.password);
    await deleteAll(admin);
    expect((await importArchive(admin, makeMiniDictionary({longTerm: '飲む'}))).state).toBe('succeeded');
});

test.afterAll(async () => {
    await deleteAll(admin);
});

async function start(page, line = LINES.plain) {
    await logIn(page);
    const sessionId = await startLookupFilm(page);
    await showLine(page, line);
    await waitForOsdHidden(page);
    await page.waitForFunction(() => document.querySelector('.yomitan-word'));
    return sessionId;
}

async function tapWord(page, text) {
    const {x, y} = await wordCentre(page, text);
    await page.touchscreen.tap(x, y);
}

/** Somewhere that is not a word, a popup or a control. */
const tapNowhere = async (page) => {
    await page.touchscreen.tap(20, 90);
};

test('this is jellyfin-web\'s mobile layout', async ({page}) => {
    await start(page);
    expect(await page.evaluate(() => document.documentElement.classList.contains('layout-mobile'))).toBe(true);
});

test('tapping a word pauses and opens the popup, and Jellyfin hears nothing of it', async ({page}) => {
    const sessionId = await start(page);
    await countPlayState(page);
    await tapWord(page, '学校');
    await expectPopup(page, '学校');
    expect(await activeWord(page)).toBe('学校');
    expect(await isPaused(page)).toBe(true);
    await expect.poll(() => serverPaused(sessionId)).toBe(true);
    await page.waitForTimeout(500);
    expect(await osdShowing(page)).toBe(false);
    expect(await playStateCounts(page)).toEqual({pause: 1, play: 0});
});

test('tapping another word swaps it, and the video stays paused', async ({page}) => {
    await start(page);
    await countPlayState(page);
    await tapWord(page, '学校');
    await expectPopup(page, '学校');
    await tapWord(page, '昨日');
    await expectPopup(page, '昨日');
    expect(await activeWord(page)).toBe('昨日');
    await page.waitForTimeout(400);
    expect(await osdShowing(page)).toBe(false);
    expect(await playStateCounts(page)).toEqual({pause: 1, play: 0});
});

test('tapping elsewhere closes it and resumes, and that tap does nothing else', async ({page}) => {
    const sessionId = await start(page);
    await tapWord(page, '学校');
    await expectPopup(page, '学校');
    await countPlayState(page);
    await tapNowhere(page);
    await expectNoPopup(page);
    await expect.poll(() => isPaused(page)).toBe(false);
    await expect.poll(() => serverPaused(sessionId)).toBe(false);
    await page.waitForTimeout(500);
    expect(await osdShowing(page), 'the closing tap did not toggle the OSD').toBe(false);
    expect(await playStateCounts(page)).toEqual({pause: 0, play: 1});
    expect(await activeWord(page)).toBeNull();
});

test('after that, tapping is jellyfin-web\'s again', async ({page}) => {
    await start(page);
    await tapWord(page, '学校');
    await expectPopup(page, '学校');
    await tapNowhere(page);
    await expectNoPopup(page);
    await page.waitForTimeout(800);
    await tapNowhere(page);
    await expect.poll(() => osdShowing(page)).toBe(true);
});

test('tapping elsewhere does not resume what the user paused', async ({page}) => {
    await start(page);
    await pauseVideo(page);
    await countPlayState(page);
    await tapWord(page, '学校');
    await expectPopup(page, '学校');
    await tapNowhere(page);
    await expectNoPopup(page);
    await page.waitForTimeout(500);
    expect(await isPaused(page)).toBe(true);
    expect(await playStateCounts(page)).toEqual({pause: 0, play: 0});
    expect(await osdShowing(page)).toBe(false);
});

test('a tap outside the subtitles with no popup open is entirely jellyfin-web\'s', async ({page}) => {
    await start(page);
    await countPlayState(page);
    await tapNowhere(page);
    await expect.poll(() => osdShowing(page)).toBe(true);
    await page.waitForTimeout(500);
    await tapNowhere(page);
    await expect.poll(() => osdShowing(page)).toBe(false);
    expect(await playStateCounts(page)).toEqual({pause: 0, play: 0});
});

test('a tap on a word no dictionary has is jellyfin-web\'s too', async ({page}) => {
    await start(page, LINES.unknown);
    await countPlayState(page);
    await tapWord(page, 'ほげほげ');
    await expect.poll(() => osdShowing(page)).toBe(true);
    expect((await popupState(page)).open).toBe(false);
    expect(await playStateCounts(page)).toEqual({pause: 0, play: 0});
});

test('a closing tap on an OSD control only closes the popup', async ({page}) => {
    await start(page);
    // A tap toggles the OSD, which can still be up from the start of the film.
    if (!await osdShowing(page)) {
        await tapNowhere(page);
    }

    await expect.poll(() => osdShowing(page)).toBe(true);
    await page.waitForTimeout(300);
    await tapWord(page, '学校');
    await expectPopup(page, '学校');

    // If the tap got through as well, the button would pause what the plugin has just resumed.
    const button = await page.locator('.videoOsdBottom .btnPause').boundingBox();
    await countPlayState(page);
    await page.touchscreen.tap(button.x + button.width / 2, button.y + button.height / 2);
    await expectNoPopup(page);
    await page.waitForTimeout(800);
    expect(await playStateCounts(page)).toEqual({pause: 0, play: 1});
});

test('tapping inside the popup leaves it open', async ({page}) => {
    await start(page);
    await tapWord(page, '学校');
    await expectPopup(page, '学校');
    const {box} = await popupState(page);
    await page.touchscreen.tap(box.left + 30, box.top + 20);
    await page.waitForTimeout(500);
    expect((await popupState(page)).open).toBe(true);
    expect(await osdShowing(page)).toBe(false);
});

test('a finger scrolls the popup, and not the page', async ({page}) => {
    await start(page, LINES.coffee);
    await tapWord(page, '飲みます');
    await expectPopup(page, '飲む');
    await expect.poll(async () => {
        const {scrollHeight, clientHeight} = await popupState(page);
        return scrollHeight > clientHeight;
    }).toBe(true);

    const {box} = await popupState(page);
    const x = box.left + box.width / 2;
    const session = await page.context().newCDPSession(page);
    const touch = (type, y) => session.send('Input.dispatchTouchEvent', {type, touchPoints: type === 'touchEnd' ? [] : [{x, y}]});
    await touch('touchStart', box.bottom - 20);
    for (let y = box.bottom - 30; y > box.top + 20; y -= 15) {
        await touch('touchMove', y);
        await page.waitForTimeout(16);
    }

    await touch('touchEnd');
    await session.detach();
    await expect.poll(async () => (await popupState(page)).scrollTop).toBeGreaterThan(40);
    const page2 = await page.evaluate(() => ({
        x: scrollX,
        y: scrollY,
        body: document.body.scrollTop,
        html: document.documentElement.scrollTop,
        view: visualViewport.offsetTop,
    }));
    expect(page2).toEqual({x: 0, y: 0, body: 0, html: 0, view: 0});
    expect(await isPaused(page), 'the scroll did not close it').toBe(true);
    expect((await popupState(page)).open).toBe(true);
    expect(await osdShowing(page)).toBe(false);
});
