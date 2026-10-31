// The popup itself: what it draws, where it goes, and what it leaves behind.
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {credentials, getMovies, logIn, play} from '../lib/jellyfin.mjs';
import {
    activeWord, expectNoPopup, expectPopup, isPaused, LINES, moveToWord, osdShowing, parkMouse, popupState, showLine,
    startLookupFilm, waitForOsdHidden,
} from '../lib/lookup.mjs';
import {makeMiniDictionary} from '../lib/mini-dictionary.mjs';
import {expectTrack, setVideoTime} from '../lib/player.mjs';
import {makeRichDictionary} from '../lib/rich-dictionary.mjs';
import {expect, test} from '../lib/test.mjs';

test.describe.configure({timeout: 120_000});

let admin;

test.beforeAll(async () => {
    admin = await clientFor(credentials.username, credentials.password);
    await deleteAll(admin);
    expect((await importArchive(admin, makeMiniDictionary({longTerm: '飲む'}))).state).toBe('succeeded');
    const rich = await importArchive(admin, makeRichDictionary());
    expect(rich.error).toBeNull();
});

test.afterAll(async () => {
    await deleteAll(admin);
});

/** The word to open by code, which is the same for mouse and touch, and what Phase 5 will do. */
function openWord(page, text) {
    return page.evaluate(async (word) => {
        const {session} = window.__yomitanJellyfin.playback;
        for (const cue of session.cues) {
            const index = session.words.get(cue.id)?.findIndex(({text: candidate}) => candidate === word) ?? -1;
            if (index >= 0) {
                return session.lookup.open({cueId: cue.id, index});
            }
        }

        throw new Error(`${word} is not on screen`);
    }, text);
}

function shadow(page, callback, argument) {
    return page.evaluate(`(${callback})(document.querySelector('.yomitan-popup').shadowRoot, ${JSON.stringify(argument ?? null)})`);
}

async function start(page, line = LINES.special) {
    await logIn(page);
    await startLookupFilm(page);
    await showLine(page, line);
}

test.describe('what it draws', () => {
    test('reading, tags, frequency, pitch, structured content and the dictionary\'s styles', async ({page}) => {
        await start(page);
        await openWord(page, '字幕');
        await expectPopup(page, '字幕');
        const drawn = await shadow(page, (root) => {
            const text = (selector) => [...root.querySelectorAll(selector)].map((node) => node.textContent);
            const note = root.querySelector('[data-sc-kind="note"]');
            return {
                reading: text('.headword-reading'),
                ruby: text('.headword-term rt').join(''),
                tags: text('.tag-label-content'),
                frequency: text('.frequency-value'),
                pitchPositions: text('.pronunciation-downstep-notation-container .pronunciation-downstep-position'),
                pitchGraphs: root.querySelectorAll('.pronunciation-graph').length,
                pitchText: root.querySelectorAll('.pronunciation-text').length,
                noteColor: getComputedStyle(note).color,
                table: text('.gloss-sc-td'),
                list: text('.gloss-sc-li'),
                details: text('.gloss-sc-summary'),
                badge: getComputedStyle(root.querySelector('[data-sc-kind="badge"]'), '::before').content,
                image: root.querySelectorAll('img.gloss-image').length,
                kanji: text('.kanji-glyph'),
                kanjiGloss: text('.kanji-gloss-content'),
                stats: text('.kanji-info-table-item-value'),
            };
        });
        expect(drawn.ruby).toBe('じまく');
        expect(drawn.tags).toEqual(expect.arrayContaining(['n', 'Rich']));
        expect(drawn.frequency.join()).toContain('1.2k');
        expect(drawn.pitchGraphs).toBeGreaterThan(0);
        expect(drawn.pitchText).toBeGreaterThan(0);
        expect(drawn.noteColor).toBe('rgb(10, 20, 30)');
        expect(drawn.table).toEqual(['cell']);
        expect(drawn.list).toEqual(['first item', 'second item']);
        expect(drawn.details).toEqual(['more']);
        expect(drawn.badge).toBe('"badge text"');
        expect(drawn.image).toBe(1);
        expect(drawn.kanji).toEqual(['字', '幕']);
        expect(drawn.kanjiGloss).toEqual(expect.arrayContaining(['character', 'curtain']));
        expect(drawn.stats).toEqual(expect.arrayContaining(['6', '13']));
    });

    test('images come through the media API as blobs, with the token', async ({page}) => {
        const mediaRequests = [];
        page.on('request', (request) => {
            if (request.url().includes('/Yomitan/Media')) {
                mediaRequests.push(request);
            }
        });
        await start(page);
        await openWord(page, '絵');
        await expectPopup(page, '絵');
        await expect.poll(() => shadow(page, (root) => [...root.querySelectorAll('img.gloss-image')].map(({complete, naturalWidth, src}) => (
            complete && naturalWidth > 0 && src.startsWith('blob:')
        )))).toEqual([true, true]);
        expect(mediaRequests.length).toBe(2);
        expect((await mediaRequests[0].allHeaders()).authorization).toContain('Token=');
    });

    test('neither side\'s CSS reaches the other', async ({page}) => {
        await start(page);
        const probe = () => page.evaluate(() => {
            const outside = document.createElement('span');
            outside.className = 'tag entry gloss-content headword';
            document.body.append(outside);
            const {padding, fontSize, borderRadius, color} = getComputedStyle(outside);
            const body = getComputedStyle(document.body);
            const result = {padding, fontSize, borderRadius, color, bodyFont: body.fontFamily, bodyColor: body.color};
            outside.remove();
            return result;
        });
        const before = await probe();
        await openWord(page, '字幕');
        await expectPopup(page, '字幕');
        expect(await probe()).toEqual(before);

        await page.addStyleTag({content: 'a, div, span, li { color: rgb(0, 255, 1) !important; font-size: 3px !important; }'});
        const inside = await shadow(page, (root) => {
            const {color, fontSize} = getComputedStyle(root.querySelector('.gloss-content'));
            return {color, fontSize};
        });
        expect(inside.color).not.toBe('rgb(0, 255, 1)');
        expect(inside.fontSize).not.toBe('3px');
    });

    test('Yomitan\'s licence notice ships with its CSS', async ({page}) => {
        await start(page);
        await openWord(page, '字幕');
        await expectPopup(page, '字幕');
        const css = await shadow(page, (root) => root.querySelector('style').textContent);
        expect(css).toContain('Yomitan Authors');
        expect(css).toContain('GNU General Public License');
    });
});

test.describe('blobs', () => {
    const trackBlobs = (page) => page.addInitScript(() => {
        const live = new Set();
        const {createObjectURL, revokeObjectURL} = URL;
        window.liveBlobs = live;
        window.blobCount = 0;
        URL.createObjectURL = (object) => {
            const url = createObjectURL.call(URL, object);
            // hls.js and the rest make blobs of their own, and those are not this test's business.
            if (object.type?.startsWith('image/')) {
                live.add(url);
                window.blobCount += 1;
            }

            return url;
        };

        URL.revokeObjectURL = (url) => {
            live.delete(url);
            revokeObjectURL.call(URL, url);
        };
    });
    const blobs = (page) => page.evaluate(() => ({live: window.liveBlobs.size, made: window.blobCount}));

    test('closing revokes them, and so does moving to another word', async ({page}) => {
        await trackBlobs(page);
        await start(page);
        await openWord(page, '絵');
        await expect.poll(async () => (await blobs(page)).live).toBe(2);

        await openWord(page, '罠').catch(() => {});
        await page.evaluate(() => window.__yomitanJellyfin.playback.session.lookup.close());
        await expect.poll(async () => (await blobs(page)).live).toBe(0);
        expect((await blobs(page)).made).toBe(2);

        for (let round = 0; round < 5; ++round) {
            await openWord(page, '絵');
            await expect.poll(async () => (await blobs(page)).live).toBe(2);
            await openWord(page, '字幕');
            await expect.poll(async () => (await blobs(page)).live).toBeLessThanOrEqual(1);
            await page.evaluate(() => window.__yomitanJellyfin.playback.session.lookup.close());
            await expect.poll(async () => (await blobs(page)).live).toBe(0);
        }

        expect((await blobs(page)).made).toBeGreaterThanOrEqual(12);
    });

    test('an image still on its way when the popup closes leaves nothing', async ({page}) => {
        await trackBlobs(page);
        let release;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        await page.route('**/Yomitan/Media**', async (route) => {
            await held;
            await route.continue().catch(() => {});
        });
        await start(page);
        await openWord(page, '絵');
        await expectPopup(page, '絵');
        await page.evaluate(() => window.__yomitanJellyfin.playback.session.lookup.close());
        release();
        await page.waitForTimeout(500);
        expect(await blobs(page)).toEqual({live: 0, made: 0});
    });

    test('ending the session revokes them', async ({page}) => {
        await trackBlobs(page);
        await start(page);
        await openWord(page, '絵');
        await expect.poll(async () => (await blobs(page)).live).toBe(2);
        await page.evaluate(() => {
            const {playbackManager: manager} = window.__yomitanJellyfin.playback;
            return manager.stop(manager.getCurrentPlayer());
        });
        await expect.poll(async () => (await blobs(page)).live).toBe(0);
    });
});

test.describe('from code, with no pointer', () => {
    test('it opens for a given word, scrolls and closes, and resumes', async ({page}) => {
        await start(page, LINES.coffee);
        expect(await openWord(page, '飲みます')).toBe(true);
        await expectPopup(page, '飲む');
        expect(await activeWord(page)).toBe('飲みます');
        expect(await isPaused(page)).toBe(true);

        await page.evaluate(() => window.__yomitanJellyfin.playback.session.lookup.scrollBy(120));
        expect((await popupState(page)).scrollTop).toBe(120);
        await page.evaluate(() => window.__yomitanJellyfin.playback.session.lookup.scrollBy(-50));
        expect((await popupState(page)).scrollTop).toBe(70);

        await page.evaluate(() => window.__yomitanJellyfin.playback.session.lookup.close());
        await expectNoPopup(page);
        await expect.poll(() => isPaused(page)).toBe(false);
    });

    test('a word no dictionary has does nothing', async ({page}) => {
        await start(page, LINES.unknown);
        expect(await openWord(page, 'ほげほげ')).toBe(false);
        expect(await isPaused(page)).toBe(false);
        expect((await popupState(page)).open).toBe(false);
    });

    test('a known word the dictionaries have lost resumes at once and shows nothing', async ({page}) => {
        await start(page, LINES.coffee);
        await page.route('**/Yomitan/Query', async (route) => {
            const response = await route.fetch();
            const body = await response.json();
            for (const result of body.results.slice(0, -1)) {
                result.rows = [];
            }

            await route.fulfill({response, json: body});
        });
        await page.evaluate(() => window.__yomitanJellyfin.playback.engine._onDictionariesChanged(window.__yomitanJellyfin.playback.engine.dictionaries));
        expect(await openWord(page, '彼女').catch(() => false)).toBe(false);
        await expect.poll(() => isPaused(page)).toBe(false);
        expect((await popupState(page)).open).toBe(false);
        await page.unrouteAll({behavior: 'ignoreErrors'});
    });
});

// Phone sizes in both orientations, a small laptop, and a television.
const SIZES = [
    {name: 'phone-portrait', width: 412, height: 839},
    {name: 'phone-landscape', width: 839, height: 412},
    {name: 'small-phone-portrait', width: 360, height: 640},
    {name: 'small-phone-landscape', width: 640, height: 360},
    {name: 'tablet-portrait', width: 768, height: 1024},
    {name: 'laptop', width: 1280, height: 720},
    {name: 'desktop', width: 1920, height: 1080},
];

async function layout(page) {
    return page.evaluate(() => {
        const rect = (element) => {
            if (!element) {
                return null;
            }

            const {left, top, right, bottom, width, height} = element.getBoundingClientRect();
            return width > 0 && height > 0 ? {left, top, right, bottom} : null;
        };

        const host = document.querySelector('.yomitan-popup');
        const frame = host?.shadowRoot.querySelector('.popup-frame');
        const box = rect(frame);
        const corners = box && [
            [box.left + 4, box.top + 4], [box.right - 4, box.top + 4], [box.left + 4, box.bottom - 4], [box.right - 4, box.bottom - 4],
        ].map(([x, y]) => document.elementFromPoint(x, y) === host);
        return {
            viewport: {width: innerWidth, height: innerHeight},
            popup: box,
            onTop: corners,
            word: rect(document.querySelector('.yomitan-active')),
            line: rect(document.querySelector('.yomitan-lines')),
            controls: rect(document.querySelector('.videoOsdBottom:not(.hide):not(.videoOsdBottom-hidden) .osdControls')),
            scrolled: [scrollX, scrollY, document.documentElement.scrollWidth - innerWidth],
        };
    });
}

/** For reading by eye. Only in Chromium, since a screenshot of a playing video can hang in headless WebKit. */
async function screenshot(page, testInfo, name) {
    if (testInfo.project.name === 'chromium' || testInfo.project.name === 'android-chrome') {
        await page.screenshot({path: testInfo.outputPath(`${name}.png`)});
    }
}

const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function expectGoodLayout({viewport, popup, onTop, word, line, controls, scrolled}, label) {
    expect(popup, label).not.toBeNull();
    expect(popup.left, label).toBeGreaterThanOrEqual(0);
    expect(popup.top, label).toBeGreaterThanOrEqual(0);
    expect(popup.right, label).toBeLessThanOrEqual(viewport.width);
    expect(popup.bottom, label).toBeLessThanOrEqual(viewport.height);
    expect(onTop, `${label}: nothing is drawn over it`).toEqual([true, true, true, true]);
    expect(overlaps(popup, word), `${label}: it does not cover the word`).toBe(false);
    expect(word.top, label).toBeGreaterThanOrEqual(0);
    expect(word.bottom, label).toBeLessThanOrEqual(viewport.height);
    if (controls) {
        expect(overlaps(line, controls), `${label}: the line is clear of the OSD`).toBe(false);
    }

    expect(scrolled, `${label}: the page has not moved`).toEqual([0, 0, 0]);
}

test.describe('where it goes', () => {
    for (const {name, width, height} of SIZES) {
        test(`at ${name}, with a long entry and a short one, OSD up or down`, async ({page}, testInfo) => {
            await page.setViewportSize({width, height});
            await start(page, LINES.coffee);

            await waitForOsdHidden(page);
            await openWord(page, '飲みます');
            await expectPopup(page, '飲む');
            const long = await popupState(page);
            expect(long.scrollHeight, 'a long entry scrolls inside').toBeGreaterThan(long.clientHeight);
            expectGoodLayout(await layout(page), `${name}, long entry`);
            await screenshot(page, testInfo, `${name}-long`);

            await openWord(page, '彼女');
            await expectPopup(page, '彼女');
            expectGoodLayout(await layout(page), `${name}, short entry`);
            await page.evaluate(() => window.__yomitanJellyfin.playback.session.lookup.close());
            await expectNoPopup(page);

            // Up comes the OSD, by the way each kind of device brings it up.
            if (testInfo.project.use.hasTouch) {
                await page.touchscreen.tap(20, height / 3);
            } else {
                await page.mouse.move(40, 40);
                await page.mouse.move(60, 60);
            }

            await expect.poll(() => osdShowing(page)).toBe(true);
            await expect.poll(async () => {
                const {line, controls} = await layout(page);
                return Boolean(line && controls && !overlaps(line, controls));
            }, {message: 'the line moves above the OSD'}).toBe(true);
            await openWord(page, '飲みます');
            await expectPopup(page, '飲む');
            expectGoodLayout(await layout(page), `${name}, OSD up`);
            await screenshot(page, testInfo, `${name}-osd`);
        });
    }

    test('a line near the top puts it below', async ({page}, testInfo) => {
        await logIn(page);
        const {TypesetSample: item} = await getMovies();
        await play(page, item, {subtitleStreamIndex: 2, minimumTime: 1});
        await expectTrack(page, {state: 'active', language: 'jpn', codec: 'ass'});
        await setVideoTime(page, 14);
        await page.waitForFunction(() => document.querySelector('.yomitan-signs .yomitan-word'));
        await page.evaluate(() => {
            const session = window.__yomitanJellyfin.playback.session;
            const cue = session.cues.find(({kind}) => kind === 'sign');
            return session.lookup.open({cueId: cue.id, index: 0});
        });
        await expect.poll(async () => (await popupState(page)).open).toBe(true);
        expect((await popupState(page)).side).toBe('below');
        expectGoodLayout(await layout(page), 'sign');
        await screenshot(page, testInfo, 'sign');
    });

    test('a line that wraps still leaves the word uncovered', async ({page}) => {
        await page.setViewportSize({width: 412, height: 839});
        await start(page, LINES.long);
        await openWord(page, '画面');
        await expectPopup(page, '画面');
        expectGoodLayout(await layout(page), 'wrapped');
    });

    test('turning the phone moves it with the word', async ({page}) => {
        await page.setViewportSize({width: 412, height: 839});
        await start(page, LINES.coffee);
        await openWord(page, '飲みます');
        await expectPopup(page, '飲む');
        await page.setViewportSize({width: 839, height: 412});
        await expect.poll(async () => (await layout(page)).viewport.width).toBe(839);
        await page.waitForTimeout(200);
        expectGoodLayout(await layout(page), 'after turning');
    });
});

test.describe('fullscreen', () => {
    test.skip(({isMobile}) => isMobile, 'Covered in the desktop browsers: requestFullscreen is the same call.');

    test('through jellyfin-web\'s own button, the popup is inside the fullscreen element and on top', async ({page, browserName}) => {
        await start(page);
        await page.mouse.move(50, 50);
        await page.mouse.move(70, 70);
        await expect.poll(() => osdShowing(page)).toBe(true);
        await page.locator('.videoOsdBottom .btnFullscreen').click();
        const entered = await page.waitForFunction(() => document.fullscreenElement !== null, null, {timeout: 5000}).then(() => true, () => false);
        test.skip(!entered && browserName === 'webkit', 'Headless WPE has no fullscreen to enter.');
        expect(entered).toBe(true);

        await parkMouse(page);
        await page.waitForTimeout(400);
        await moveToWord(page, '字幕');
        await expectPopup(page, '字幕');
        const state = await page.evaluate(() => {
            const host = document.querySelector('.yomitan-popup');
            const {left, top} = host.getBoundingClientRect();
            return {
                inside: document.fullscreenElement.contains(host),
                element: document.fullscreenElement.tagName,
                onTop: document.elementFromPoint(left + 20, top + 20) === host,
            };
        });
        expect(state).toEqual({inside: true, element: 'HTML', onTop: true});
        expectGoodLayout(await layout(page), 'fullscreen');
        await page.keyboard.press('Space');
        await expectNoPopup(page);
    });

    test('if something other than the page goes fullscreen, the layer moves into it', async ({page}) => {
        await start(page);
        await page.evaluate(() => {
            const container = document.createElement('div');
            container.id = 'fullscreen-test';
            document.body.append(container);
        });
        // Fullscreen takes a user gesture, and a real click is one.
        await page.evaluate(() => {
            window.addEventListener('pointerdown', () => {
                window.fullscreenResult = document.getElementById('fullscreen-test').requestFullscreen().then(() => true, () => false);
            }, {once: true, capture: true});
        });
        await page.mouse.click(5, 300);
        const entered = await page.evaluate(() => window.fullscreenResult);
        test.skip(!entered, 'This browser refused a fullscreen without a real gesture.');
        await expect.poll(() => page.evaluate(() => document.getElementById('fullscreen-test').contains(document.querySelector('.yomitan-layer')))).toBe(true);
        await page.evaluate(() => document.exitFullscreen());
        await expect.poll(() => page.evaluate(() => document.querySelector('.yomitan-layer').parentElement === document.body)).toBe(true);
    });
});
