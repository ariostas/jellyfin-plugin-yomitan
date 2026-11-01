// The popup on real dictionaries: JMdict and KANJIDIC, with real frequency and pitch data. These are not in the
// repository, so this takes a directory in YOMITAN_REAL_DICTS holding JMdict_english.zip and KANJIDIC_english.zip, and if
// present the two lists tests/lib/real-meta-dictionaries.mjs describes, and jitendex-yomitan.zip from jitendex.org
// (CC BY-SA 4.0), which is the real dictionary here with images and a stylesheet of its own.
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {credentials, logIn} from '../lib/jellyfin.mjs';
import {expectCursor, useTvLayout} from '../lib/keys.mjs';
import {expectNoPopup, expectPopup, LINES, moveToWord, parkMouse, pauseVideo, popupState, showLine, startLookupFilm, wordCentre} from '../lib/lookup.mjs';
import {makeFrequencyDictionary, makePitchDictionary} from '../lib/real-meta-dictionaries.mjs';
import {expect, test} from '../lib/test.mjs';

const directory = process.env.YOMITAN_REAL_DICTS;

test.skip(!directory, 'Needs YOMITAN_REAL_DICTS.');
test.describe.configure({timeout: 240_000, mode: 'serial'});

let admin;
let extras;

test.beforeAll(async () => {
    test.setTimeout(240_000);
    admin = await clientFor(credentials.username, credentials.password);
    await deleteAll(admin);
    for (const file of ['JMdict_english.zip', 'KANJIDIC_english.zip']) {
        const job = await importArchive(admin, readFileSync(join(directory, file)));
        expect(job.error).toBeNull();
    }

    const jitendex = join(directory, 'jitendex-yomitan.zip');
    extras = {
        frequency: makeFrequencyDictionary(directory),
        pitch: makePitchDictionary(directory),
        jitendex: existsSync(jitendex) ? readFileSync(jitendex) : null,
    };
    for (const archive of Object.values(extras)) {
        if (archive) {
            const job = await importArchive(admin, archive);
            expect(job.error).toBeNull();
        }
    }
});

test.afterAll(async () => {
    await deleteAll(admin);
});

async function start(page, line) {
    await logIn(page);
    await startLookupFilm(page);
    await parkMouse(page);
    await showLine(page, line);
}

const open = (page, text) => page.evaluate(async (word) => {
    const {session} = window.__yomitanJellyfin.playback;
    for (const cue of session.cues) {
        const index = session.words.get(cue.id)?.findIndex(({text: candidate}) => candidate === word) ?? -1;
        if (index >= 0) {
            return session.lookup.open({cueId: cue.id, index});
        }
    }

    throw new Error(`${word} is not on screen`);
}, text);

test('a real entry: glossary, tags, inflection, frequency and pitch', async ({page}, testInfo) => {
    await start(page, LINES.coffee);
    await moveToWord(page, '飲みます');
    await expectPopup(page, '飲む');
    const drawn = await page.evaluate(() => {
        const {shadowRoot: root} = document.querySelector('.yomitan-popup');
        const text = (selector) => [...root.querySelectorAll(selector)].map((node) => node.textContent);
        return {
            glosses: text('.gloss-content').join(' | '),
            inflection: text('.inflection').join(' '),
            frequency: text('.frequency-value').join(' '),
            dictionaries: text('.tag[data-category=dictionary] .tag-label-content'),
            pitch: root.querySelectorAll('.pronunciation').length,
            kanji: text('.kanji-glyph'),
        };
    });
    console.log('a real entry:', {...drawn, glosses: `${drawn.glosses.slice(0, 80)}…`});
    expect(drawn.glosses).toContain('to drink');
    expect(drawn.inflection).toContain('-ます');
    expect(drawn.kanji).toEqual(['飲']);
    if (extras.frequency) {
        expect(drawn.frequency).toMatch(/\d/);
    }

    if (extras.pitch) {
        expect(drawn.pitch).toBeGreaterThan(0);
    }

    await page.screenshot({path: testInfo.outputPath('real-entry.png')});
});

for (const [name, viewport, line, word, term] of [
    ['desktop', {width: 1280, height: 720}, LINES.plain, '行きませんでした', '行く'],
    ['phone portrait', {width: 412, height: 839}, LINES.plain, '行きませんでした', '行く'],
    ['phone landscape', {width: 839, height: 412}, LINES.plain, '行きませんでした', '行く'],
    ['phone portrait, a short word', {width: 412, height: 839}, LINES.coffee, 'コーヒー', 'コーヒー'],
    ['phone landscape, the longest kind of entry', {width: 839, height: 412}, LINES.twoLines, 'の', 'の'],
]) {
    test(`a screenshot at ${name}`, async ({page}, testInfo) => {
        await page.setViewportSize(viewport);
        await start(page, line);
        await open(page, word);
        await expectPopup(page, term);
        const {scrollHeight, clientHeight, box} = await popupState(page);
        console.log(`${name}: entries are ${scrollHeight} px, showing ${clientHeight} px, popup ${Math.round(box.width)} by ${Math.round(box.height)}`);
        await page.screenshot({path: testInfo.outputPath(`${name}.png`)});
    });
}

for (const [name, viewport, tv] of [['the desktop layout', {width: 1920, height: 1080}, false], ['the TV layout', {width: 1920, height: 1080}, true]]) {
    test(`the word cursor in ${name}, on a real entry`, async ({page}, testInfo) => {
        test.skip(testInfo.project.use.isMobile, 'A phone has no keys.');
        await page.setViewportSize(viewport);
        if (tv) {
            await useTvLayout(page);
        }

        await start(page, LINES.plain);
        await pauseVideo(page);
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, '昨日');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, '学校');
        await page.screenshot({path: testInfo.outputPath(`cursor, ${name}.png`)});
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await expectCursor(page, '行きませんでした', '行く');
        const {scrollHeight, clientHeight} = await popupState(page);
        expect(scrollHeight).toBeGreaterThan(clientHeight);
        await page.keyboard.press('ArrowDown');
        await expect.poll(async () => (await popupState(page)).scrollTop).toBeGreaterThan(0);
        await page.screenshot({path: testInfo.outputPath(`scrolled, ${name}.png`)});
    });
}

test.describe('a real dictionary with images and styles', () => {
    test.skip(() => !existsSync(join(directory ?? '', 'jitendex-yomitan.zip')), 'Needs jitendex-yomitan.zip.');

    test('its photograph and its SVG glyph load from the media API, as blobs', async ({page}, testInfo) => {
        const failures = [];
        page.on('response', (response) => {
            if (response.url().includes('/Yomitan/Media') && !response.ok()) {
                failures.push(response.url());
            }
        });
        await start(page, LINES.twoLines);
        await open(page, '炬燵');
        await expectPopup(page, '炬燵');
        const photos = () => page.evaluate(() => {
            const {shadowRoot} = document.querySelector('.yomitan-popup');
            return [...shadowRoot.querySelectorAll('img.gloss-image')].map(({src, naturalWidth, complete}) => ({
                blob: src.startsWith('blob:'),
                loaded: complete && naturalWidth > 0,
            }));
        });
        await expect.poll(async () => (await photos()).some(({blob, loaded}) => blob && loaded), {timeout: 10_000}).toBe(true);
        expect((await photos()).every(({blob}) => blob)).toBe(true);
        await page.screenshot({path: testInfo.outputPath('photograph.png')});

        await open(page, '兎');
        await expectPopup(page, '兎');
        await expect.poll(async () => (await photos()).some(({loaded}) => loaded), {timeout: 10_000}).toBe(true);
        expect(failures).toEqual([]);
        await page.screenshot({path: testInfo.outputPath('glyph.png')});
    });

    test('its stylesheet survives the sanitizer whole, and applies', async ({page}, testInfo) => {
        await start(page, LINES.coffee);
        await open(page, '彼女');
        await expectPopup(page, '彼女');
        const result = await page.evaluate(() => {
            const count = (rules) => [...rules].reduce((total, rule) => total + 1 + (rule.cssRules ? count(rule.cssRules) : 0), 0);
            const {engine} = window.__yomitanJellyfin.playback;
            const {styles} = engine.dictionaries.find(({title}) => title.startsWith('Jitendex'));
            const original = new CSSStyleSheet();
            original.replaceSync(styles);

            const {shadowRoot: root} = document.querySelector('.yomitan-popup');
            const [scope] = root.querySelectorAll('style')[1].sheet.cssRules;
            const sense = root.querySelector('[data-dictionary^="Jitendex"] li[data-sc-content="sense"]');
            return {
                source: count(original.cssRules),
                kept: count(scope.cssRules),
                dropped: root.querySelectorAll('style')[1].textContent.includes('url('),
                padding: sense ? getComputedStyle(sense).paddingLeft : null,
            };
        });
        console.log('Jitendex styles.css through the sanitizer:', result);
        expect(result.kept).toBe(result.source);
        expect(result.padding).not.toBe('0px');
        await page.screenshot({path: testInfo.outputPath('styled.png')});
    });
});

function percentile(sorted, fraction) {
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

test('from hovering to a painted popup', async ({page}) => {
    await start(page, LINES.plain);
    const rounds = 3;
    const words = [
        [LINES.plain, ['昨日', '学校', '行きませんでした']],
        [LINES.unknown, ['猫', 'です']],
        [LINES.twoLines, ['猫', '窓', '外', '見ています', '友達', '映画', '見ました']],
        [LINES.special, ['飲みます', '字幕']],
        [LINES.coffee, ['彼女', 'コーヒー', '飲みます']],
        [LINES.long, ['長い', '画面', '文章', '本当に']],
    ];

    // Watches from the page, so the numbers do not include talking to Playwright: the clock starts at the event that puts
    // the mouse on the word, and stops at the frame after the one that first has the popup, which has then been painted.
    await page.evaluate(() => {
        window.samples = [];
        let start = 0;
        document.addEventListener('pointermove', ({target}) => {
            if (target.matches?.('.yomitan-word') && !start) {
                start = performance.now();
            }
        }, {capture: true});
        const watch = () => {
            const host = document.querySelector('.yomitan-popup');
            if (start && host && !host.hidden && host.style.visibility !== 'hidden') {
                const began = start;
                start = 0;
                requestAnimationFrame(() => {
                    window.samples.push(performance.now() - began);
                });
            }

            requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
    });

    const measured = [];
    for (let round = 0; round < rounds; ++round) {
        for (const [line, list] of words) {
            await showLine(page, line);
            for (const text of list) {
                const before = await page.evaluate(() => window.samples.length);
                const {x, y} = await wordCentre(page, text);
                await page.mouse.move(x, y);
                await expect.poll(() => page.evaluate(() => window.samples.length), {intervals: [50]}).toBe(before + 1);
                measured.push({round, text, ms: await page.evaluate(() => window.samples.at(-1))});
                await parkMouse(page);
                await expectNoPopup(page);
            }
        }
    }

    const report = (label, samples) => {
        const sorted = samples.map(({ms}) => ms).sort((a, b) => a - b);
        const summary = {
            samples: sorted.length,
            median: Math.round(percentile(sorted, 0.5)),
            p95: Math.round(percentile(sorted, 0.95)),
            worst: Math.round(sorted.at(-1)),
        };
        console.log(`${label}:`, summary);
        return summary;
    };

    const all = report('hover to painted popup, all, including the 200 ms hover delay', measured);
    report('first time each word was seen', measured.filter(({round}) => round === 0));
    report('seen before', measured.filter(({round}) => round > 0));
    expect(all.p95).toBeLessThan(800);
});
