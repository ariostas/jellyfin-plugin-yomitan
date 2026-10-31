// The mouse, in real playback. Input goes through page.mouse and the keyboard, so hit testing and jellyfin-web's own
// handlers are all involved, and what counts is the state of the video element and of the server.
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {credentials, getEpisodes, logIn} from '../lib/jellyfin.mjs';
import {
    activeWord, countPlayState, expectNoPopup, expectPopup, isPaused, LINES, moveToWord, osdShowing, parkMouse, pauseVideo,
    playStateCounts, popupState, serverPaused, showLine, startLookupFilm, videoState, waitForOsdHidden, wordCentre,
} from '../lib/lookup.mjs';
import {makeMiniDictionary} from '../lib/mini-dictionary.mjs';
import {setSubtitleTrack, stopPlayback} from '../lib/player.mjs';
import {expect, test} from '../lib/test.mjs';

test.describe.configure({timeout: 120_000});
test.skip(({isMobile}) => isMobile, 'A phone has no mouse. See touch.spec.mjs.');

let admin;

test.beforeAll(async () => {
    admin = await clientFor(credentials.username, credentials.password);
    await deleteAll(admin);
    expect((await importArchive(admin, makeMiniDictionary({longTerm: '飲む'}))).state).toBe('succeeded');
});

test.afterAll(async () => {
    await deleteAll(admin);
});

/** The default hover delay and grace period, which these tests lean on. settings.spec.mjs changes them. */
const HOVER_DELAY = 200;
const GRACE = 300;

async function start(page, line = LINES.plain) {
    await logIn(page);
    const sessionId = await startLookupFilm(page);
    await parkMouse(page);
    await showLine(page, line);
    return sessionId;
}

test.describe('hovering a word', () => {
    test('pauses a playing video, shows the popup and marks the word, and the server sees the pause', async ({page}) => {
        const sessionId = await start(page);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        expect(await isPaused(page)).toBe(true);
        expect(await activeWord(page)).toBe('学校');
        expect((await popupState(page)).text).toContain('meaning of 学校');
        await expect.poll(() => serverPaused(sessionId)).toBe(true);
    });

    test('an inflected word finds its dictionary form', async ({page}) => {
        await start(page);
        await moveToWord(page, '行きませんでした');
        await expectPopup(page, '行く');
        expect((await popupState(page)).text).toContain('meaning of 行く');
    });

    test('moving to another word swaps the popup and stays paused', async ({page}) => {
        await start(page);
        await countPlayState(page);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await moveToWord(page, '昨日');
        await expectPopup(page, '昨日');
        expect(await activeWord(page)).toBe('昨日');
        expect(await isPaused(page)).toBe(true);
        expect((await playStateCounts(page)).play).toBe(0);
        expect(await page.locator('.yomitan-popup').count()).toBe(1);
    });

    test('the mouse can cross the gap into the popup, stay there, and scroll it with the wheel', async ({page}) => {
        await start(page, LINES.coffee);
        const {x, y} = await moveToWord(page, '飲みます');
        await expectPopup(page, '飲む');

        const popup = await popupState(page);
        expect(popup.box.bottom).toBeLessThanOrEqual(y);
        await page.mouse.move(popup.box.left + 40, popup.box.bottom - 6, {steps: 6});
        await page.waitForTimeout(GRACE * 2);
        expect((await popupState(page)).open).toBe(true);
        expect(await isPaused(page)).toBe(true);

        // The wheel must not reach jellyfin-web as well, which turns it into volume.
        expect(popup.scrollHeight).toBeGreaterThan(popup.clientHeight);
        const volume = (await videoState(page)).volume;
        await page.mouse.wheel(0, 40);
        await expect.poll(async () => (await popupState(page)).scrollTop).toBeGreaterThan(0);
        expect((await videoState(page)).volume).toBe(volume);

        await page.mouse.move(x, y, {steps: 3});
        await page.waitForTimeout(GRACE * 2);
        expect((await popupState(page)).open).toBe(true);
    });

    test('moving away from both closes after the grace period, and resumes what the plugin paused', async ({page}) => {
        const sessionId = await start(page);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await expect.poll(() => serverPaused(sessionId)).toBe(true);

        await parkMouse(page);
        const left = Date.now();
        await page.waitForTimeout(GRACE / 3);
        expect((await popupState(page)).open, 'the popup is still there during the grace period').toBe(true);
        expect(await isPaused(page)).toBe(true);

        await expectNoPopup(page);
        expect(Date.now() - left).toBeGreaterThanOrEqual(GRACE - 50);
        await expect.poll(() => isPaused(page)).toBe(false);
        expect(await activeWord(page)).toBeNull();
        await expect.poll(() => serverPaused(sessionId)).toBe(false);
    });

    test('coming back within the grace period keeps it open', async ({page}) => {
        await start(page);
        const {x, y} = await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await parkMouse(page);
        await page.waitForTimeout(GRACE / 3);
        await page.mouse.move(x, y, {steps: 2});
        await page.waitForTimeout(GRACE * 2);
        expect((await popupState(page)).open).toBe(true);
        expect(await isPaused(page)).toBe(true);
    });

    test('hovering while paused shows a popup, and leaving does not resume', async ({page}) => {
        await start(page);
        await pauseVideo(page);
        await countPlayState(page);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await parkMouse(page);
        await expectNoPopup(page);
        await page.waitForTimeout(400);
        expect(await isPaused(page)).toBe(true);
        expect(await playStateCounts(page)).toEqual({pause: 0, play: 0});
    });

    test('a word no dictionary has shows nothing and does not pause', async ({page}) => {
        await start(page, LINES.unknown);
        await countPlayState(page);
        await moveToWord(page, 'ほげほげ');
        await page.waitForTimeout(HOVER_DELAY * 3);
        expect((await popupState(page)).open).toBe(false);
        expect(await playStateCounts(page)).toEqual({pause: 0, play: 0});
    });

    test('a line not yet split into words takes no hover', async ({page}) => {
        await logIn(page);
        await startLookupFilm(page);
        await parkMouse(page);
        // No answers, so the next line stays plain text.
        await page.route('**/Yomitan/Query', () => {});
        await showLinePlain(page, LINES.coffee);
        await countPlayState(page);
        const {x, y} = await page.evaluate(() => {
            const {left, top, width, height} = document.querySelector('.yomitan-lines .yomitan-line').getBoundingClientRect();
            return {x: left + width / 2, y: top + height / 2};
        });
        await page.mouse.move(x, y, {steps: 3});
        await page.waitForTimeout(HOVER_DELAY * 3);
        expect(await page.locator('.yomitan-word').count()).toBe(0);
        expect(await playStateCounts(page)).toEqual({pause: 0, play: 0});
    });

    test('a click on a word opens it at once and does not toggle playback', async ({page}) => {
        await start(page);
        await countPlayState(page);
        const {x, y} = await wordCentre(page, '学校');
        await page.mouse.click(x, y);
        await expectPopup(page, '学校');
        await page.waitForTimeout(500);
        expect(await playStateCounts(page)).toEqual({pause: 1, play: 0});
    });

    test('a click in a gap between words is still jellyfin-web\'s', async ({page}) => {
        await start(page);
        const {x, y} = await wordCentre(page, '昨日');
        // Over the line, where there is no word, and well clear of the OSD.
        await page.mouse.click(x, y - 70);
        await expect.poll(() => isPaused(page)).toBe(true);
        expect((await popupState(page)).open).toBe(false);
    });
});

async function showLinePlain(page, {at}) {
    await page.evaluate((target) => {
        const manager = window.__yomitanJellyfin.playback.playbackManager;
        manager.seek(Math.round(target * 1e7), manager.getCurrentPlayer());
    }, at);
    await page.waitForFunction(() => window.__yomitanJellyfin.playback.session.cues[0]?.text.startsWith('彼女'));
}

test.describe('a mouse that is only passing', () => {
    test('crossing the line quickly does not pause', async ({page}) => {
        await start(page);
        await countPlayState(page);
        const first = await wordCentre(page, '昨日');
        const last = await wordCentre(page, '行きませんでした');
        // About 1500 px/s, which is a person going somewhere else.
        await page.mouse.move(first.x - 100, first.y - 80);
        await page.mouse.move(last.x + 100, last.y + 80, {steps: 12});
        await page.waitForTimeout(HOVER_DELAY * 2);
        expect(await playStateCounts(page)).toEqual({pause: 0, play: 0});
        expect((await popupState(page)).open).toBe(false);
    });

    test('going for the OSD through the line does not pause', async ({page}) => {
        await start(page);
        await countPlayState(page);
        const {x, y} = await wordCentre(page, '学校');
        await page.mouse.move(x, y - 150);
        // Wait for the OSD and the line's move out of its way, so the path crosses where the line really is.
        await expect.poll(() => osdShowing(page)).toBe(true);
        await page.waitForTimeout(300);
        const word = await wordCentre(page, '学校');
        const button = await page.locator('.videoOsdBottom .btnPause').boundingBox();
        const steps = 10;
        for (let step = 1; step <= steps; ++step) {
            const part = step / steps;
            await page.mouse.move(
                word.x + (button.x + button.width / 2 - word.x) * part,
                word.y - 100 + (button.y + button.height / 2 - word.y + 100) * part,
            );
            await page.waitForTimeout(12);
        }

        await page.waitForTimeout(HOVER_DELAY * 2);
        expect(await playStateCounts(page)).toEqual({pause: 0, play: 0});
        expect((await popupState(page)).open).toBe(false);
    });

    test('a line appearing under a resting mouse does not pause', async ({page}) => {
        await start(page, LINES.plain);
        const {x, y} = await wordCentre(page, '学校');
        // In the gap before the line, with the mouse at rest where a word will be.
        await page.mouse.move(x, y, {steps: 2});
        await expectPopup(page, '学校');
        await parkMouse(page);
        await expectNoPopup(page);
        await expect.poll(() => isPaused(page)).toBe(false);
        await waitForOsdHidden(page);

        await page.mouse.move(x, y + 300);
        await page.evaluate(() => {
            document.querySelector('.yomitan-overlay').style.visibility = 'hidden';
        });
        await page.mouse.move(x, y);
        await countPlayState(page);
        await page.evaluate(() => {
            document.querySelector('.yomitan-overlay').style.visibility = '';
        });
        await page.waitForTimeout(HOVER_DELAY * 3);
        expect(await playStateCounts(page)).toEqual({pause: 0, play: 0});
        expect((await popupState(page)).open).toBe(false);
    });
});

test.describe('words that go away', () => {
    test('a line that ends during the hover delay leaves nothing behind', async ({page}) => {
        await start(page);
        await page.evaluate(() => window.__yomitanJellyfin.settings.set('hoverDelayMs', 800));
        const line = await wordCentre(page, '学校');
        await page.mouse.move(line.x, line.y - 200);
        await page.waitForTimeout(100);
        await showLine(page, {at: 9.1});
        await countPlayState(page);
        await moveToWord(page, '学校');
        // The line ends at 9.5 s, inside the delay. That word is then not there to open.
        await page.waitForFunction(() => window.__yomitanJellyfin.playback.session.cues.length === 0, null, {timeout: 3000});
        await page.waitForTimeout(1000);
        expect(await playStateCounts(page)).toEqual({pause: 0, play: 0});
        expect((await popupState(page)).open).toBe(false);
    });

    test('the mouse leaving the window counts as moving away', async ({page}) => {
        await start(page);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await page.mouse.move(-20, 300);
        await expectNoPopup(page);
        await expect.poll(() => isPaused(page)).toBe(false);
    });
});

test.describe('closing', () => {
    test('space resumes, closes the popup, and is not undone', async ({page}) => {
        await start(page);
        const {x, y} = await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await countPlayState(page);
        await page.keyboard.press('Space');
        await expectNoPopup(page);
        await page.waitForTimeout(500);
        expect(await isPaused(page)).toBe(false);
        expect(await playStateCounts(page)).toEqual({pause: 0, play: 1});

        // The word is still under the mouse. A small movement must not bring it all back.
        await page.mouse.move(x + 2, y + 1);
        await page.waitForTimeout(HOVER_DELAY * 3);
        expect(await isPaused(page)).toBe(false);
        expect((await popupState(page)).open).toBe(false);
    });

    test('space on a video the user paused also closes it, and playing wins', async ({page}) => {
        await start(page);
        await pauseVideo(page);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await page.keyboard.press('Space');
        await expectNoPopup(page);
        await page.waitForTimeout(400);
        expect(await isPaused(page)).toBe(false);
    });

    test('the OSD\'s play button closes it, and is not undone', async ({page}) => {
        await start(page);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await page.locator('.videoOsdBottom .btnPause').click();
        await expectNoPopup(page);
        await page.waitForTimeout(600);
        expect(await isPaused(page)).toBe(false);
    });

    test('seeking closes it, and resumes what the plugin paused', async ({page}) => {
        await start(page);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await page.keyboard.press('Digit5');
        await expectNoPopup(page);
        await expect.poll(() => isPaused(page)).toBe(false);
    });

    test('seeking while the user has paused closes it and stays paused', async ({page}) => {
        await start(page);
        await pauseVideo(page);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await page.keyboard.press('Digit5');
        await expectNoPopup(page);
        await page.waitForTimeout(500);
        expect(await isPaused(page)).toBe(true);
    });

    test('changing the subtitle track closes it, and the pause does not stay behind', async ({page}) => {
        await start(page);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await setSubtitleTrack(page, -1);
        await expect.poll(() => page.locator('.yomitan-popup').count()).toBe(0);
        await expect.poll(() => isPaused(page)).toBe(false);
    });

    test('leaving the player closes it and leaves nothing behind', async ({page}) => {
        await start(page);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await stopPlayback(page);
        await expect.poll(() => page.locator('.yomitan-layer').count()).toBe(0);
        await expect.poll(() => page.locator('.yomitan-popup').count()).toBe(0);
    });

    test('a failure of the plugin closes it and resumes', async ({page}) => {
        await start(page);
        await page.route('**/Yomitan/Query', (route) => route.fulfill({status: 500, body: 'no'}));
        await moveToWord(page, '学校');
        await expect.poll(() => isPaused(page)).toBe(true);
        // The lookup fails after its retries, about 2 s later, and nothing is left paused or open.
        await expect.poll(() => isPaused(page), {timeout: 10_000}).toBe(false);
        expect((await popupState(page)).open).toBe(false);
        expect(await activeWord(page)).toBeNull();
    });

    test('an inactive event closes it', async ({page}) => {
        await start(page);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await page.evaluate(() => window.__yomitanJellyfin.playback.session._fail(new Error('from a test')));
        await expect.poll(() => page.locator('.yomitan-popup').count()).toBe(0);
        await expect.poll(() => isPaused(page)).toBe(false);
        expect(await page.locator('.yomitan-overlay').count()).toBe(0);
    });

    test('the next episode closes it', async ({page}) => {
        await start(page);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        const [episode] = await getEpisodes();
        await page.evaluate((id) => {
            const {playbackManager: manager} = window.__yomitanJellyfin.playback;
            return manager.play({ids: [id], serverId: window.ApiClient.serverId()});
        }, episode);
        await expect.poll(() => page.locator('.yomitan-popup').count()).toBe(0);
    });
});

test.describe('the OSD', () => {
    test('the line moves clear of its controls, and comes back when it hides', async ({page}) => {
        await start(page);
        await page.mouse.move(100, 100);
        await page.mouse.move(140, 140);
        await expect.poll(() => osdShowing(page)).toBe(true);
        const clearOfControls = () => page.evaluate(() => {
            const line = document.querySelector('.yomitan-lines').getBoundingClientRect();
            const controls = document.querySelector('.osdControls').getBoundingClientRect();
            return controls.top - line.bottom;
        });
        await expect.poll(clearOfControls).toBeGreaterThanOrEqual(0);

        const raised = (await wordCentre(page, '学校')).y;
        await waitForOsdHidden(page);
        await expect.poll(async () => (await wordCentre(page, '学校')).y).toBeGreaterThanOrEqual(raised);
    });

    test('its controls take clicks while a line is up', async ({page}) => {
        await start(page);
        await page.mouse.move(100, 100);
        await page.mouse.move(140, 140);
        await expect.poll(() => osdShowing(page)).toBe(true);
        await page.locator('.videoOsdBottom .btnPause').click();
        await expect.poll(() => isPaused(page)).toBe(true);
    });

    test('the word in use stays put when the OSD hides by itself', async ({page}) => {
        await start(page);
        const {y} = await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await waitForOsdHidden(page);
        await page.waitForTimeout(400);
        expect((await wordCentre(page, '学校')).y).toBe(y);
        expect((await popupState(page)).open).toBe(true);
    });
});
