// The keyboard and a remote, in real playback. Every key is real input, through the browser. jellyfin-web treats a TV
// remote's keys as these same key events, but no physical remote has been near this. A key the plugin should leave alone
// is compared with what the same key does with the plugin off, because that is the claim, and no list here could keep up
// with what jellyfin-web does with a key.
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {credentials, getMovies, logIn, play, readSettings} from '../lib/jellyfin.mjs';
import {
    effectOf, expectCursor, expectLeft, inWordMode, jellyfinState, pressCode, REMOTE_KEYS, setEnabled, setPlayer, setUpOnly,
    useTvLayout, waitForActive,
} from '../lib/keys.mjs';
import {
    activeWord, countPlayState, expectNoPopup, expectPopup, isPaused, LINES, moveToWord, osdShowing, parkMouse, pauseVideo,
    playStateCounts, popupState, serverPaused, showLine, startLookupFilm, videoState, wordCentre,
} from '../lib/lookup.mjs';
import {makeMiniDictionary} from '../lib/mini-dictionary.mjs';
import {expectTrack, setSubtitleOffset, setSubtitleTrack, setVideoTime, stopPlayback} from '../lib/player.mjs';
import {expect, test} from '../lib/test.mjs';

test.describe.configure({timeout: 120_000});

let admin;
let movies;

test.beforeAll(async () => {
    admin = await clientFor(credentials.username, credentials.password);
    await deleteAll(admin);
    expect((await importArchive(admin, makeMiniDictionary({longTerm: '飲む'}))).state).toBe('succeeded');
    movies = await getMovies();
});

test.afterAll(async () => {
    await deleteAll(admin);
});

const LAYOUTS = [
    {name: 'desktop layout', tv: false, use: {}},
    {name: 'TV layout', tv: true, use: {viewport: {width: 1920, height: 1080}}},
];

const TV_ON_A_PHONE = 'A phone has no TV layout worth testing. The same code runs in the desktop layout here.';

async function start(page, {tv = false, line = LINES.plain} = {}) {
    if (tv) {
        await useTvLayout(page);
    }

    await logIn(page);
    const sessionId = await startLookupFilm(page);
    await parkMouse(page);
    await showLine(page, line);
    return sessionId;
}

/** Pauses with the key this layout pauses with, which leaves the OSD up with its pause button in focus. */
async function pauseWithKey(page, tv) {
    await page.keyboard.press(tv ? 'Enter' : 'Space');
    await expect.poll(() => isPaused(page)).toBe(true);
    await expect.poll(() => osdShowing(page)).toBe(true);
}

/** Resumes as another device would. Nothing waits for play(): see setPlayer. */
function resumeVideo(page) {
    return page.evaluate(() => {
        document.querySelector('video.htmlvideoplayer').play().catch(() => {});
    });
}

/** Starts in word mode on the first word of a line. */
async function enterWordMode(page, options = {}) {
    const sessionId = await start(page, options);
    await pauseVideo(page);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => inWordMode(page)).toBe(true);
    return sessionId;
}

/** The most the popup is from its word, with the line's own spacing. */
const POPUP_GAP = 14;

const onPlayer = (page) => page.evaluate(() => location.hash.startsWith('#/video') && document.querySelector('video.htmlvideoplayer') !== null);

for (const {name, tv, use} of LAYOUTS) {
    test.describe(name, () => {
        test.use(use);
        test.skip(({isMobile}) => tv && isMobile, TV_ON_A_PHONE);

        test('the whole flow: in, along, scroll, out, in again, resume', async ({page}) => {
            const sessionId = await start(page, {tv, line: LINES.coffee});
            await countPlayState(page);
            await pauseWithKey(page, tv);
            // A first playback on a new server can take its time here.
            await expect.poll(() => serverPaused(sessionId), {timeout: 20_000}).toBe(true);
            const {time} = await videoState(page);

            await page.keyboard.press('ArrowRight');
            await expectCursor(page, '彼女');
            expect(await osdShowing(page)).toBe(false);

            await page.keyboard.press('ArrowRight');
            await expectCursor(page, 'は');
            await page.keyboard.press('ArrowRight');
            await expectCursor(page, 'コーヒー');
            await page.keyboard.press('ArrowLeft');
            await expectCursor(page, 'は');
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('ArrowRight');
            await expectCursor(page, '飲みます', '飲む');

            const {scrollHeight, clientHeight} = await popupState(page);
            expect(scrollHeight).toBeGreaterThan(clientHeight);
            await page.keyboard.press('ArrowDown');
            await expect.poll(async () => (await popupState(page)).scrollTop).toBe(120);
            await page.keyboard.press('ArrowDown');
            await expect.poll(async () => (await popupState(page)).scrollTop).toBe(240);
            await page.keyboard.press('ArrowUp');
            await expect.poll(async () => (await popupState(page)).scrollTop).toBe(120);

            await page.keyboard.press('Escape');
            await expectLeft(page);
            await expectNoPopup(page);
            expect(await isPaused(page)).toBe(true);
            expect(await osdShowing(page)).toBe(false);
            expect(await onPlayer(page)).toBe(true);

            await page.keyboard.press('ArrowUp');
            await expectCursor(page, '彼女');
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.press('ArrowRight');
            await expectCursor(page, 'は');

            expect(Math.abs((await videoState(page)).time - time)).toBeLessThan(0.01);
            expect((await playStateCounts(page)).play).toBe(0);

            await page.keyboard.press('Enter');
            await expect.poll(() => isPaused(page)).toBe(false);
            await expectLeft(page);
            await expectNoPopup(page);
            await expect.poll(() => serverPaused(sessionId), {timeout: 20_000}).toBe(false);
            await page.waitForTimeout(400);
            expect(await isPaused(page)).toBe(false);
            expect(await playStateCounts(page)).toEqual({pause: 1, play: 1});
        });

        test('Left and Up enter as Right does, and on the first word with the OSD already gone too', async ({page}) => {
            await start(page, {tv});
            await pauseVideo(page);
            await expect.poll(() => osdShowing(page), {timeout: 8000}).toBe(false);
            const url = page.url();
            await page.keyboard.press('ArrowLeft');
            await expectCursor(page, '昨日');
            await page.keyboard.press('Backspace');
            await expectLeft(page);
            await page.keyboard.press('ArrowUp');
            await expectCursor(page, '昨日');
            await page.waitForTimeout(300);
            expect(page.url()).toBe(url);
            expect(await onPlayer(page)).toBe(true);
        });

        test('no key of the flow leaks: limits of the words and of the scroll do nothing at all', async ({page}) => {
            await enterWordMode(page, {tv, line: LINES.unknown});
            await expectCursor(page, 'は');
            const before = await jellyfinState(page);

            // ほげほげ has no entry, so は comes first, and the left end is here.
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.press('ArrowUp');
            await page.waitForTimeout(200);
            expect(await activeWord(page)).toBe('は');
            for (const key of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight']) {
                await page.keyboard.press(key);
            }

            await expectCursor(page, 'です');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('ArrowUp');
            await page.keyboard.press('ArrowUp');
            await page.waitForTimeout(300);
            expect(await activeWord(page)).toBe('です');
            expect(await jellyfinState(page)).toEqual(before);
        });

        test('every Back key leaves word mode, stays paused and stays in the player', async ({page, browserName}) => {
            await enterWordMode(page, {tv});
            const check = async () => {
                await expectLeft(page);
                await expectNoPopup(page);
                await page.waitForTimeout(250);
                expect(await isPaused(page)).toBe(true);
                expect(await onPlayer(page)).toBe(true);
            };

            await page.keyboard.press('Escape');
            await check();
            await page.keyboard.press('ArrowRight');
            await expectCursor(page, '昨日');
            await page.keyboard.press('Backspace');
            await check();
            test.skip(browserName !== 'chromium', 'Only Chromium\'s debugger can press a key that is not on a US keyboard.');
            for (const key of Object.values(REMOTE_KEYS)) {
                await page.keyboard.press('ArrowUp');
                await expectCursor(page, '昨日');
                await pressCode(page, key);
                await check();
            }
        });

        test('a Back or an Enter held down does not carry on into jellyfin-web', async ({page}) => {
            await enterWordMode(page, {tv});
            await expectCursor(page, '昨日');
            for (let repeats = 0; repeats < 4; repeats += 1) {
                await page.keyboard.down('Escape');
            }

            await page.keyboard.up('Escape');
            await expectLeft(page);
            await page.waitForTimeout(300);
            expect(await onPlayer(page)).toBe(true);
            expect(await isPaused(page)).toBe(true);

            await page.keyboard.press('ArrowRight');
            await expectCursor(page, '昨日');
            for (let repeats = 0; repeats < 4; repeats += 1) {
                await page.keyboard.down('Enter');
            }

            await page.keyboard.up('Enter');
            await expect.poll(() => isPaused(page)).toBe(false);
            await page.waitForTimeout(400);
            expect(await isPaused(page)).toBe(false);
        });

        test('Left and Right held down keep moving', async ({page}) => {
            await enterWordMode(page, {tv, line: LINES.coffee});
            await expectCursor(page, '彼女');
            for (let repeats = 0; repeats < 3; repeats += 1) {
                await page.keyboard.down('ArrowRight');
            }

            await page.keyboard.up('ArrowRight');
            await expectCursor(page, 'を');
        });

        test('Enter resumes, and does not also press what has focus', async ({page}) => {
            await start(page, {tv});
            await pauseWithKey(page, tv);
            await countPlayState(page);
            await page.keyboard.press('ArrowRight');
            await expectCursor(page, '昨日');
            await page.keyboard.press('Enter');
            await expect.poll(() => isPaused(page)).toBe(false);
            await page.waitForTimeout(400);
            expect(await playStateCounts(page)).toEqual({pause: 0, play: 1});

            // jellyfin-web takes focus off the OSD when it hides, so put it back on the worst button there is for this.
            await pauseVideo(page);
            await page.keyboard.press('ArrowRight');
            await expectCursor(page, '昨日');
            await page.evaluate(() => document.querySelector('.btnSubtitles').focus());
            await page.keyboard.press('Enter');
            await expect.poll(() => isPaused(page)).toBe(false);
            await page.waitForTimeout(400);
            expect((await jellyfinState(page)).dialogs).toBe(0);
        });
    });
}

test.describe('selecting the TV layout', () => {
    test.skip(({isMobile}) => isMobile, TV_ON_A_PHONE);

    test('as a user does, in Display settings, gives the layout these specs store', async ({page}) => {
        await logIn(page);
        await page.evaluate(() => {
            location.hash = `#/mypreferencesdisplay?userId=${window.ApiClient.getCurrentUserId()}`;
        });
        await page.getByRole('combobox', {name: /Display mode/i}).click();
        await page.getByRole('option', {name: 'TV'}).click();
        await page.getByRole('button', {name: /save/i}).click();
        await expect.poll(() => page.evaluate(() => ({
            layout: localStorage.getItem('layout'),
            tv: document.documentElement.classList.contains('layout-tv'),
        }))).toEqual({layout: 'tv', tv: true});
    });
});

test.describe('words and lines', () => {
    test('the cursor runs across a cue\'s line breaks', async ({page}) => {
        await enterWordMode(page, {line: LINES.twoLines});
        await expectCursor(page, '猫');
        for (let presses = 0; presses < 9; presses += 1) {
            await page.keyboard.press('ArrowRight');
        }

        await page.waitForTimeout(200);
        const {y: first} = await wordCentre(page, '猫');
        const {y: here} = await wordCentre(page, await activeWord(page));
        expect(here).toBeGreaterThan(first);
    });

    test('with dialogue and a sign, it starts in the dialogue, and Left reaches the sign above', async ({page}) => {
        await logIn(page);
        await play(page, movies.TypesetSample, {subtitleStreamIndex: 2, minimumTime: 0.2});
        await expectTrack(page, {state: 'active', codec: 'ass'});
        await parkMouse(page);
        await pauseVideo(page);
        await setVideoTime(page, 14);
        await page.waitForFunction(() => document.querySelector('.yomitan-signs .yomitan-word') && document.querySelector('.yomitan-lines .yomitan-word'));
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, '看板');
        await page.keyboard.press('ArrowLeft');
        await expectCursor(page, '商店街');
        const {side} = await popupState(page);
        expect(side).toBe('below');
        await page.keyboard.press('ArrowLeft');
        await expectCursor(page, '駅前');
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(200);
        expect(await activeWord(page)).toBe('駅前');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, '看板');
    });

    test('a line still being split claims the key, and the cursor lands when the words come', async ({page}) => {
        await start(page);
        await pauseVideo(page);
        await page.route('**/Yomitan/Query', async (route) => {
            await new Promise((resolve) => {
                setTimeout(resolve, 1500);
            });
            await route.continue().catch(() => {});
        });
        await setVideoTime(page, LINES.long.at);
        await page.waitForFunction(() => document.querySelector('.yomitan-line') && !document.querySelector('.yomitan-word') && !document.querySelector('video.htmlvideoplayer').seeking);
        const {time} = await videoState(page);
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        expect(await inWordMode(page)).toBe(true);
        await expectCursor(page, 'これ');
        expect(Math.abs((await videoState(page)).time - time)).toBeLessThan(0.01);
        await page.unrouteAll({behavior: 'ignoreErrors'});
    });

    test('Back while a line is still being split leaves, and nothing lands later', async ({page}) => {
        await start(page);
        await pauseVideo(page);
        await page.route('**/Yomitan/Query', async (route) => {
            await new Promise((resolve) => {
                setTimeout(resolve, 800);
            });
            await route.continue().catch(() => {});
        });
        await setVideoTime(page, LINES.long.at);
        await page.waitForFunction(() => document.querySelector('.yomitan-line') && !document.querySelector('.yomitan-word') && !document.querySelector('video.htmlvideoplayer').seeking);
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Escape');
        expect(await inWordMode(page)).toBe(false);
        await page.waitForFunction(() => document.querySelector('.yomitan-word'));
        await page.waitForTimeout(400);
        expect(await activeWord(page)).toBeNull();
        expect(await inWordMode(page)).toBe(false);
        expect(await onPlayer(page)).toBe(true);
        await page.unrouteAll({behavior: 'ignoreErrors'});
    });

    test('keys pressed faster than lookups come back land on the last word, and only there', async ({page}) => {
        await enterWordMode(page, {line: LINES.coffee});
        await expectCursor(page, '彼女');
        await page.route('**/Yomitan/Query', async (route) => {
            await new Promise((resolve) => {
                setTimeout(resolve, 400);
            });
            await route.continue().catch(() => {});
        });
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        expect(await activeWord(page)).toBe('を');
        await expectCursor(page, 'を');
        await page.waitForTimeout(900);
        expect(await activeWord(page)).toBe('を');
        expect((await popupState(page)).headwords).toEqual(['を']);
        await page.unrouteAll({behavior: 'ignoreErrors'});
    });

    test('a word that finds nothing after all is skipped, either way, and the end of the line stays reachable', async ({page}) => {
        await enterWordMode(page, {line: LINES.coffee});
        await expectCursor(page, '彼女');
        await page.evaluate(() => {
            const {engine} = window.__yomitanJellyfin.playback;
            const lookup = engine.lookup.bind(engine);
            engine.lookup = async (text) => (['は', '飲みます'].includes(text) ? {dictionaryEntries: []} : lookup(text));
        });
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, 'コーヒー');
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, 'を');
        // The last word finds nothing, so the cursor turns back rather than ending up nowhere.
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, 'を');
        await page.keyboard.press('ArrowLeft');
        await expectCursor(page, 'コーヒー');
        await page.keyboard.press('ArrowLeft');
        await expectCursor(page, '彼女');
        expect(await isPaused(page)).toBe(true);
    });

    test('a lookup that fails leaves word mode, paused, and a new try works', async ({page}) => {
        await enterWordMode(page, {line: LINES.coffee});
        await expectCursor(page, '彼女');
        await page.evaluate(() => {
            const {engine} = window.__yomitanJellyfin.playback;
            window.realLookup = engine.lookup;
            engine.lookup = async () => {
                throw new Error('from the test');
            };
        });
        await page.keyboard.press('ArrowRight');
        await expectLeft(page);
        await expectNoPopup(page);
        expect(await isPaused(page)).toBe(true);
        await page.evaluate(() => {
            window.__yomitanJellyfin.playback.engine.lookup = window.realLookup;
        });
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, '彼女');
    });
});

test.describe('entering', () => {
    test('moves the line down out of the OSD\'s old place, with the popup next to it', async ({page}) => {
        await start(page);
        await pauseWithKey(page, false);
        await expect.poll(async () => page.evaluate(() => document.querySelector('.yomitan-overlay').style.getPropertyValue('--yomitan-osd-bottom'))).not.toBe('0px');
        const {y: raised} = await wordCentre(page, '昨日');
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, '昨日');
        const {y, top} = await wordCentre(page, '昨日');
        expect(y).toBeGreaterThan(raised);
        const {box} = await popupState(page);
        expect(top - box.bottom).toBeGreaterThanOrEqual(0);
        expect(top - box.bottom).toBeLessThan(POPUP_GAP);
    });

    test('a key held down while the video pauses does not fall into word mode', async ({page}) => {
        await start(page);
        await page.keyboard.down('ArrowUp');
        await pauseVideo(page);
        await page.keyboard.down('ArrowUp');
        await page.keyboard.down('ArrowUp');
        await page.keyboard.up('ArrowUp');
        await page.waitForTimeout(200);
        expect(await inWordMode(page)).toBe(false);
        await page.keyboard.press('ArrowUp');
        await expect.poll(() => inWordMode(page)).toBe(true);
    });
});

test.describe('starting from a pointer\'s popup', () => {
    test.skip(({isMobile}) => isMobile, 'A phone has no mouse.');

    test('the word it shows is where the cursor starts, the pause stays, and the mouse lets go', async ({page}) => {
        await start(page);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        expect(await isPaused(page)).toBe(true);

        await page.keyboard.press('ArrowRight');
        await expect.poll(() => inWordMode(page)).toBe(true);
        expect(await activeWord(page)).toBe('学校');
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, 'に');

        // Longer than the grace period, with the mouse where it was. The cursor moved away from it and nothing happened.
        await page.waitForTimeout(600);
        await expectCursor(page, 'に');

        await page.keyboard.press('Escape');
        await expectLeft(page);
        await page.waitForTimeout(300);
        expect(await isPaused(page)).toBe(true);
    });

    test('with the OSD up and the line moved for it, the popup follows the line down', async ({page}) => {
        await start(page);
        await page.keyboard.press('Space');
        await expect.poll(() => osdShowing(page)).toBe(true);
        await expect.poll(async () => page.evaluate(() => document.querySelector('.yomitan-overlay').style.getPropertyValue('--yomitan-osd-bottom'))).not.toBe('0px');
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        const {y: raised} = await wordCentre(page, '学校');
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => inWordMode(page)).toBe(true);
        const {y, top} = await wordCentre(page, '学校');
        expect(y).toBeGreaterThan(raised);
        const {box} = await popupState(page);
        expect(top - box.bottom).toBeGreaterThanOrEqual(0);
        expect(top - box.bottom).toBeLessThan(POPUP_GAP);
    });

    test('a popup the mouse was leaving stays once a key has taken it', async ({page}) => {
        await start(page);
        // Time for a key in the grace period, in a browser that delivers moves up to 300 ms apart.
        await page.evaluate(() => window.__yomitanJellyfin.settings.set('hoverGraceMs', 1500));
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await parkMouse(page);
        await page.keyboard.press('ArrowUp');
        await expect.poll(() => inWordMode(page)).toBe(true);
        await page.waitForTimeout(1800);
        await expectCursor(page, '学校');
    });

    test('once word mode is over, a mouse that barely moved is a mouse again', async ({page}) => {
        await start(page);
        await pauseVideo(page);
        const {x, y} = await moveToWord(page, '学校');
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, '昨日');
        await page.keyboard.press('Escape');
        await expectLeft(page);
        await page.mouse.move(x + 3, y);
        await expectPopup(page, '学校');
    });

    test('a hover about to open does not land on top of the cursor', async ({page}) => {
        await start(page);
        await pauseVideo(page);
        await moveToWord(page, '学校');
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, '昨日');
        await page.waitForTimeout(500);
        await expectCursor(page, '昨日');
    });
});

test.describe('other input while in word mode', () => {
    test('moving the mouse hands the popup to it, closes it on leaving, and leaves one state', async ({page, isMobile}) => {
        test.skip(isMobile, 'A phone has no mouse.');
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        await page.mouse.move(120, 320, {steps: 3});
        await expect.poll(() => inWordMode(page)).toBe(false);
        await expectNoPopup(page);
        expect(await activeWord(page)).toBeNull();
        expect(await isPaused(page)).toBe(true);
    });

    test('a hand resting on the mouse does nothing', async ({page, isMobile}) => {
        test.skip(isMobile, 'A phone has no mouse.');
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        const {x, y} = await page.evaluate(() => ({x: 3, y: 200}));
        await page.mouse.move(x + 1, y + 1);
        await page.mouse.move(x + 3, y);
        await page.waitForTimeout(600);
        await expectCursor(page, '昨日');
    });

    test('the mouse resting on another word swaps the popup, with one highlight and the OSD to itself', async ({page, isMobile}) => {
        test.skip(isMobile, 'A phone has no mouse.');
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        await moveToWord(page, '学校');
        await expect.poll(() => inWordMode(page)).toBe(false);
        await expectPopup(page, '学校');
        expect(await page.locator('.yomitan-active').count()).toBe(1);
        expect(await page.locator('.yomitan-popup').count()).toBe(1);
        expect((await popupState(page)).headwords).toEqual(['学校']);

        // Keys are no longer the cursor's. Back to the first one, from the top.
        await parkMouse(page);
        await expectNoPopup(page);
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, '昨日');
    });

    test('a click on a word opens it and ends word mode', async ({page, isMobile}) => {
        test.skip(isMobile, 'A phone has no mouse.');
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        const {x, y} = await wordCentre(page, '学校');
        await page.mouse.click(x, y);
        await expect.poll(() => inWordMode(page)).toBe(false);
        await expectPopup(page, '学校');
        expect(await isPaused(page)).toBe(true);
        expect(await page.locator('.yomitan-active').count()).toBe(1);
    });

    test('a finger on another word swaps it, and elsewhere closes it', async ({page, hasTouch}) => {
        test.skip(!hasTouch, 'This needs a touch screen.');
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        const {x, y} = await wordCentre(page, '学校');
        await page.touchscreen.tap(x, y);
        await expect.poll(() => inWordMode(page)).toBe(false);
        await expectPopup(page, '学校');
        expect(await page.locator('.yomitan-active').count()).toBe(1);
        await page.touchscreen.tap(30, 30);
        await expectNoPopup(page);
        expect(await activeWord(page)).toBeNull();
        expect(await isPaused(page)).toBe(true);
    });

    test('a finger elsewhere closes it, with the video still paused', async ({page, hasTouch}) => {
        test.skip(!hasTouch, 'This needs a touch screen.');
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        await page.touchscreen.tap(30, 30);
        await expectNoPopup(page);
        await expectLeft(page);
        expect(await isPaused(page)).toBe(true);
    });
});

test.describe('word mode ends with', () => {
    test('a key of jellyfin-web\'s that resumes', async ({page}) => {
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        await page.keyboard.press('Space');
        await expect.poll(() => isPaused(page)).toBe(false);
        await expectLeft(page);
        await expectNoPopup(page);
    });

    test('a key of jellyfin-web\'s that seeks, which leaves it paused', async ({page}) => {
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        await page.keyboard.press('5');
        await expectLeft(page);
        await expectNoPopup(page);
        await expect.poll(async () => (await videoState(page)).time).toBeGreaterThan(25);
        expect(await isPaused(page)).toBe(true);
    });

    test('resuming from elsewhere, like another device', async ({page}) => {
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        await resumeVideo(page);
        await expectLeft(page);
        await expectNoPopup(page);
    });

    test('turning subtitles off, and the keys are jellyfin-web\'s from then on', async ({page}) => {
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        await setSubtitleTrack(page, -1);
        await expect.poll(() => page.locator('.yomitan-overlay').count()).toBe(0);
        expect(await page.locator('.yomitan-popup').count()).toBe(0);
        const before = (await videoState(page)).time;
        await page.keyboard.press('ArrowRight');
        await expect.poll(async () => (await videoState(page)).time).toBeGreaterThan(before + 5);
    });

    test('leaving the player', async ({page}) => {
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        await stopPlayback(page);
        await expect.poll(() => page.locator('.yomitan-layer').count()).toBe(0);
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Escape');
        expect(await page.evaluate(() => document.querySelector('.yomitan-word-mode'))).toBeNull();
    });

    test('a failure that ends the overlay, with Jellyfin\'s line back and the keys its own', async ({page}) => {
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        await page.evaluate(() => window.__yomitanJellyfin.playback.session._fail(new Error('from the test')));
        await expect.poll(() => page.locator('.yomitan-overlay').count()).toBe(0);
        expect(await page.evaluate(() => window.__yomitanJellyfin.playback.session.state)).toBe('inactive');
        const before = (await videoState(page)).time;
        await page.keyboard.press('ArrowRight');
        await expect.poll(async () => (await videoState(page)).time).toBeGreaterThan(before + 5);
    });

    test('a new subtitle offset that takes the line away', async ({page}) => {
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        await setSubtitleOffset(page, 15);
        await expectLeft(page);
        await expectNoPopup(page);
        expect(await isPaused(page)).toBe(true);
    });

    test('resuming, or a seek, before a cursor waiting for its line has landed', async ({page}) => {
        await start(page);
        await pauseVideo(page);
        await page.route('**/Yomitan/Query', async (route) => {
            await new Promise((resolve) => {
                setTimeout(resolve, 1500);
            });
            await route.continue().catch(() => {});
        });
        await setVideoTime(page, LINES.long.at);
        await page.waitForFunction(() => document.querySelector('.yomitan-line') && !document.querySelector('.yomitan-word') && !document.querySelector('video.htmlvideoplayer').seeking);
        await page.keyboard.press('ArrowRight');
        expect(await inWordMode(page)).toBe(true);
        await resumeVideo(page);
        await expect.poll(() => inWordMode(page)).toBe(false);
        await page.waitForFunction(() => document.querySelector('.yomitan-word'));
        await page.waitForTimeout(300);
        expect(await activeWord(page)).toBeNull();
        expect(await isPaused(page)).toBe(false);
        await page.unrouteAll({behavior: 'ignoreErrors'});
    });

    test('a line that never splits, while the cursor waits for it', async ({page}) => {
        await start(page);
        await pauseVideo(page);
        await page.route('**/Yomitan/Query', (route) => route.fulfill({status: 500}));
        await setVideoTime(page, LINES.long.at);
        await page.waitForFunction(() => document.querySelector('.yomitan-line') && !document.querySelector('.yomitan-word'));
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => page.locator('.yomitan-overlay').count(), {timeout: 15_000}).toBe(0);
        expect(await isPaused(page)).toBe(true);
        await page.unrouteAll({behavior: 'ignoreErrors'});
    });

    test('leaving the player, and it all works again for the next film', async ({page}) => {
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        await stopPlayback(page);
        await expect.poll(() => page.locator('.yomitan-layer').count()).toBe(0);
        await startLookupFilm(page);
        await showLine(page, LINES.coffee);
        await page.keyboard.press('Space');
        await expect.poll(() => osdShowing(page)).toBe(true);
        expect(await page.locator('.videoOsdBottom').count()).toBe(2);
        const raised = (await wordCentre(page, '彼女')).y;
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, '彼女');
        expect(await osdShowing(page)).toBe(false);
        expect(await onPlayer(page)).toBe(true);

        // jellyfin-web keeps the first film's page, with an OSD that looks shown. The line goes by the page on screen.
        const {y, height} = await wordCentre(page, '彼女');
        expect(y).toBeGreaterThan(raised);
        expect(y + height).toBeLessThan(page.viewportSize().height);
    });

    test('turning the plugin off', async ({page}) => {
        await enterWordMode(page);
        await expectCursor(page, '昨日');
        await setEnabled(page, false);
        await expect.poll(() => page.locator('.yomitan-layer').count()).toBe(0);
        expect(await isPaused(page)).toBe(true);
    });
});

/** Runs each key from the same state, with the plugin off and then on, and the two must match. */
async function expectSameAsJellyfin(page, cases) {
    const run = async () => {
        const seen = [];
        for (const {keys, prepare, after} of cases) {
            for (const key of keys) {
                await prepare();
                seen.push(await effectOf(page, key, {after}));
            }
        }

        return seen;
    };

    await setEnabled(page, false);
    const off = await run();
    await setEnabled(page, true);
    await waitForActive(page);
    const on = await run();
    expect(await inWordMode(page)).toBe(false);
    expect(on).toEqual(off);
}

const LINE = LINES.twoLines.at;
/** jellyfin-web's position slider seeks a second after its last key. */
const SLIDER_DELAY = 1600;
const OPEN_MENU = '.dialogContainer .dialog.opened';

async function focusOn(page, selector) {
    await page.evaluate((target) => document.querySelector(target).focus(), selector);
}

for (const {name, tv, use} of LAYOUTS) {
    test.describe(`left to jellyfin-web, compared with the plugin off, in the ${name}`, () => {
        test.use(use);
        test.skip(({isMobile}) => isMobile, 'Keys on a phone are not a case worth this much time. The code is the same.');

        const arrows = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

        test('normal playback', async ({page}) => {
            await start(page, {tv});
            const hidden = () => setPlayer(page, {at: LINE, paused: false});
            const shown = () => setPlayer(page, {at: LINE, paused: false, osd: true});
            await expectSameAsJellyfin(page, [
                // Escape with the OSD hidden leaves the player in the TV layout, so it has its own test. Left and Right
                // there go through the position slider, which seeks a second later.
                {prepare: hidden, keys: [...arrows, 'Enter', 'Backspace', ...tv ? [] : ['Escape']], after: tv ? SLIDER_DELAY : 0},
                {prepare: shown, keys: [...arrows, 'Enter', 'Backspace', 'Escape']},
            ]);
        });

        test('paused, without word mode: Down, Enter and Back', async ({page}) => {
            await start(page, {tv});
            await expectSameAsJellyfin(page, [
                {prepare: () => setPlayer(page, {at: LINE, paused: true}), keys: ['ArrowDown', 'Enter', 'Backspace']},
                {prepare: () => setPlayer(page, {at: LINE, paused: true, osd: true}), keys: ['ArrowDown', 'Enter', 'Escape', 'Backspace']},
            ]);
        });

        test('with no line on screen, or nothing a dictionary has on it', async ({page}) => {
            await start(page, {tv});
            const between = async () => {
                await setPlayer(page, {at: 9.7, paused: true});
                await page.waitForFunction(() => document.querySelector('.yomitan-line') === null);
            };

            const unknown = async () => {
                await setPlayer(page, {at: LINE, paused: true});
                await page.evaluate(() => {
                    const session = window.__yomitanJellyfin.playback?.session;
                    for (const [id, words] of session?.words ?? []) {
                        session.words.set(id, words.map((word) => ({...word, known: false})));
                    }
                });
            };

            await expectSameAsJellyfin(page, [
                {prepare: between, keys: arrows, after: tv ? SLIDER_DELAY : 0},
                {prepare: unknown, keys: arrows, after: tv ? SLIDER_DELAY : 0},
            ]);
        });

        test('a menu of Jellyfin\'s open over the player', async ({page}) => {
            await start(page, {tv});
            const menu = (button) => async () => {
                await setPlayer(page, {at: LINE, paused: true, osd: true});
                await page.locator(button).click();
                await page.locator(OPEN_MENU).waitFor();
                await parkMouse(page);
                // It takes focus when its animation ends, in the TV layout. Elsewhere it leaves focus to chance.
                await page.waitForTimeout(400);
                if (!tv) {
                    await page.evaluate(() => document.activeElement?.blur());
                }
            };
            await expectSameAsJellyfin(page, [
                {prepare: menu('.btnVideoOsdSettings'), keys: [...arrows, 'Enter', 'Escape', 'Backspace']},
                {prepare: menu('.btnSubtitles'), keys: [...arrows, 'Escape']},
            ]);
        });

        test('a text field: the subtitle offset', async ({page}) => {
            await start(page, {tv});
            const field = async () => {
                await setPlayer(page, {at: LINE, paused: true, osd: true});
                await page.evaluate(() => {
                    const manager = window.__yomitanJellyfin.playback.playbackManager;
                    manager.setSubtitleOffset(0, manager.getCurrentPlayer());
                });
                await page.locator('.btnVideoOsdSettings').click();
                await page.locator(`${OPEN_MENU} [data-id=suboffset]`).click();
                await page.locator('.subtitleSyncTextField').click();
            };
            await expectSameAsJellyfin(page, [{prepare: field, keys: [...arrows, 'Enter']}]);
        });

        test('modifier keys held', async ({page}) => {
            await start(page, {tv});
            const paused = () => setPlayer(page, {at: LINE, paused: true});
            await expectSameAsJellyfin(page, [{
                prepare: paused,
                keys: [
                    ...arrows.map((key) => `Shift+${key}`),
                    'Shift+Enter', 'Shift+Backspace', 'Control+ArrowRight', 'Control+ArrowUp', 'Control+ArrowDown',
                    'Alt+ArrowUp', 'Alt+ArrowDown', 'Meta+ArrowRight', 'Meta+ArrowUp',
                ],
            }]);
        });

        test('a slider in focus', async ({page}) => {
            await start(page, {tv});
            const slider = async () => {
                await setPlayer(page, {at: LINE, paused: true, osd: true});
                await focusOn(page, '.osdPositionSlider');
            };
            // A slider takes a key's seek a second later, in case another key follows.
            await expectSameAsJellyfin(page, [{prepare: slider, keys: arrows, after: SLIDER_DELAY}]);
        });

        test('Up-only: Left and Right stay Jellyfin\'s until Up enters', async ({page}) => {
            await start(page, {tv});
            await setUpOnly(page, true);
            const buttons = () => setPlayer(page, {at: LINE, paused: true, osd: true});
            await expectSameAsJellyfin(page, [{prepare: buttons, keys: ['ArrowLeft', 'ArrowRight']}]);

            await setPlayer(page, {at: LINE, paused: true});
            await page.keyboard.press('ArrowUp');
            await expectCursor(page, '猫');
            await page.keyboard.press('ArrowRight');
            await expectCursor(page, 'が');
            await page.keyboard.press('ArrowLeft');
            await expectCursor(page, '猫');
        });

        test('a track that is not active leaves everything alone', async ({page}) => {
            await start(page, {tv});
            await page.evaluate(() => window.__yomitanJellyfin.playback.session._fail(new Error('from the test')));
            await expect.poll(() => page.locator('.yomitan-overlay').count()).toBe(0);
            const paused = () => setPlayer(page, {at: LINE, paused: true, osd: true});
            const inactive = [];
            for (const key of arrows) {
                await paused();
                inactive.push(await effectOf(page, key));
            }

            await setEnabled(page, false);
            const off = [];
            for (const key of arrows) {
                await paused();
                off.push(await effectOf(page, key));
            }

            expect(inactive).toEqual(off);
        });
    });
}

test.describe('Back in the TV layout, outside word mode, is still Jellyfin\'s', () => {
    test.use({viewport: {width: 1920, height: 1080}});
    test.skip(({isMobile}) => isMobile, TV_ON_A_PHONE);

    test('it leaves the player while playing, as it does with the plugin off', async ({page}) => {
        await start(page, {tv: true});
        await setPlayer(page, {at: LINE, paused: false});
        await page.keyboard.press('Escape');
        await expect.poll(() => onPlayer(page)).toBe(false);
    });

    test('and a second Back after leaving word mode leaves the player too', async ({page}) => {
        await enterWordMode(page, {tv: true});
        await expectCursor(page, '昨日');
        await page.keyboard.press('Escape');
        await expectLeft(page);
        expect(await onPlayer(page)).toBe(true);
        await page.keyboard.press('Escape');
        await expect.poll(() => onPlayer(page)).toBe(false);
    });
});

test.describe('the setting', () => {
    test('is off by default, and stored like the others', async ({page}) => {
        await logIn(page);
        expect(await page.evaluate(() => window.__yomitanJellyfin.settings.get('upOnlyEntry'))).toBe(false);
        await page.evaluate(() => window.__yomitanJellyfin.settings.set('upOnlyEntry', true));
        await page.reload();
        await page.waitForFunction(() => window.__yomitanJellyfin?.settings.get('upOnlyEntry') === true);
        await expect.poll(async () => (await readSettings(credentials)).upOnlyEntry).toBe(true);
    });
});
