// A user's choice of dictionaries, proved by what the overlay and the popup do, and by what the server is asked.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {credentials, logIn} from '../lib/jellyfin.mjs';
import {expectPopup, isPaused, LINES, moveToWord, parkMouse, popupState, showLine, startLookupFilm} from '../lib/lookup.mjs';
import {makeMiniDictionary} from '../lib/mini-dictionary.mjs';
import {jellyfinLine, overlayWords} from '../lib/player.mjs';
import {expect, test} from '../lib/test.mjs';
import {makeDictionary} from '../lib/zip.mjs';

test.describe.configure({timeout: 120_000});

const beta = () => makeDictionary({title: 'Beta', format: 3, revision: '1', sequenced: true}, {
    'term_bank_1.json': [['学校', 'がっこう', 'n', '', 0, ['beta school'], 1, ''], ['昨日', 'きのう', 'n', '', 0, ['beta yesterday'], 2, '']],
});
const kanjiOnly = () => makeDictionary({title: 'KanjiOnly', format: 3, revision: '1'}, {
    'kanji_bank_1.json': [['学', 'ガク', 'まな.ぶ', '', ['study'], {}]],
});

let admin;

test.beforeAll(async () => {
    admin = await clientFor(credentials.username, credentials.password);
    await deleteAll(admin);
    for (const archive of [makeMiniDictionary(), beta(), kanjiOnly()]) {
        expect((await importArchive(admin, archive)).state).toBe('succeeded');
    }
});

test.afterAll(async () => {
    await deleteAll(admin);
});

test.afterEach(async () => {
    await admin.remove('Gamma');
    await expect.poll(async () => (await (await admin.list()).json()).dictionaries.some(({title}) => title === 'Gamma')).toBe(false);
});

const setDictionaries = (page, name, value) => page.evaluate(([setting, titles]) => window.__yomitanJellyfin.settings.set(setting, titles), [name, value]);
const known = (page) => page.evaluate(() => [...document.querySelectorAll('.yomitan-lines .yomitan-word:not(.yomitan-unknown)')].map(({textContent}) => textContent));
const generation = (page) => page.evaluate(() => window.__yomitanJellyfin.playback.engine.generation);
const titlesInUse = (page) => page.evaluate(() => window.__yomitanJellyfin.playback.engine.titles);

async function start(page, settings = {}) {
    await logIn(page, {settings: {enabled: true, ...settings}});
    await startLookupFilm(page);
    await parkMouse(page);
    await showLine(page, LINES.plain);
}

async function open(page, word) {
    await moveToWord(page, word);
    await expectPopup(page, word);
    return (await popupState(page)).text;
}

test('both on: the popup shows both, in import order, and the line is split with both', async ({page, isMobile}) => {
    test.skip(isMobile, 'The mouse is the short way.');
    await start(page);
    expect(await known(page)).toEqual(['昨日', 'は', '学校', 'に', '行きませんでした']);
    const text = await open(page, '学校');
    expect(text.indexOf('meaning of 学校')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('beta school')).toBeGreaterThan(text.indexOf('meaning of 学校'));
});

test('order is priority: the first in the user\'s list comes first in the popup', async ({page, isMobile}) => {
    test.skip(isMobile, 'The mouse is the short way.');
    await start(page, {dictionaryOrder: ['Beta', 'Mini']});
    const text = await open(page, '学校');
    expect(text.indexOf('beta school')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('meaning of 学校')).toBeGreaterThan(text.indexOf('beta school'));
    expect(await titlesInUse(page)).toEqual(['Beta', 'Mini', 'KanjiOnly']);
});

test('turning one off changes the line and the popup while the video plays', async ({page, isMobile}) => {
    test.skip(isMobile, 'The mouse is the short way.');
    await start(page);
    const before = await generation(page);
    await setDictionaries(page, 'disabledDictionaries', ['Mini']);

    // From here on. A request for the next line can already be on its way as the setting changes.
    const bodies = [];
    page.on('request', (request) => {
        if (request.url().endsWith('/Yomitan/Query')) {
            bodies.push(JSON.parse(request.postData()));
        }
    });

    await expect.poll(() => known(page)).toEqual(['昨日', '学校']);
    expect(await generation(page)).toBeGreaterThan(before);
    expect(await titlesInUse(page)).toEqual(['Beta', 'KanjiOnly']);
    expect(await overlayWords(page).then((words) => words.map(({text}) => text).join(''))).toBe('昨日は学校に行きませんでした');

    const text = await open(page, '学校');
    expect(text).toContain('beta school');
    expect(text).not.toContain('meaning of 学校');

    // Nothing asked the server about the dictionary that is off, for the line, for the popup or for its tags.
    const named = bodies.flatMap(({operations}) => operations.flatMap(({dictionaries}) => dictionaries ?? []));
    expect(named.length).toBeGreaterThan(0);
    expect(named).not.toContain('Mini');

    await parkMouse(page);
    await expect.poll(() => isPaused(page)).toBe(false);
    await setDictionaries(page, 'disabledDictionaries', []);
    await expect.poll(() => known(page)).toEqual(['昨日', 'は', '学校', 'に', '行きませんでした']);
});

test('a popup open when the set changes closes, rather than showing what is off', async ({page, isMobile}) => {
    test.skip(isMobile, 'The mouse is the short way.');
    await start(page);
    await open(page, '学校');
    await setDictionaries(page, 'disabledDictionaries', ['Mini']);
    await expect.poll(async () => (await popupState(page)).open).toBe(false);
    await expect.poll(() => isPaused(page)).toBe(false);
});

test('nothing with words left: the line goes back to Jellyfin, it says why, and turning one on brings it back', async ({page}) => {
    await start(page);
    await setDictionaries(page, 'disabledDictionaries', ['Mini', 'Beta']);
    await expect(page.locator('.yomitan-notice')).toContainText('hold no words');
    await expect.poll(() => page.locator('.yomitan-overlay').count()).toBe(0);
    await expect.poll(() => jellyfinLine(page)).toBe('showing');

    await setDictionaries(page, 'disabledDictionaries', ['Mini', 'Beta', 'KanjiOnly']);
    await page.waitForTimeout(800);
    expect(await page.locator('.yomitan-overlay').count()).toBe(0);

    await setDictionaries(page, 'disabledDictionaries', ['Mini']);
    await page.waitForFunction(() => window.__yomitanJellyfin.playback.session?.state === 'active');
    await showLine(page, LINES.plain);
    expect(await known(page)).toEqual(['昨日', '学校']);
});

test('one installed after the user saved is on, and the last, with no one touching anything', async ({page, isMobile}) => {
    test.skip(isMobile, 'The mouse is the short way.');
    await start(page, {dictionaryOrder: ['Beta', 'Mini', 'KanjiOnly'], disabledDictionaries: ['KanjiOnly']});
    await importArchive(admin, makeDictionary({title: 'Gamma', format: 3, revision: '1', sequenced: true}, {
        'term_bank_1.json': [['学校', 'がっこう', 'n', '', 0, ['gamma school'], 1, '']],
    }));
    try {
        // The session notices with the next request it makes, as it would at the next line.
        await page.evaluate(() => window.__yomitanJellyfin.playback.engine.prefetch(['新しい行']));
        await expect.poll(() => titlesInUse(page)).toEqual(['Beta', 'Mini', 'Gamma']);
        await showLine(page, LINES.plain);
        const text = await open(page, '学校');
        expect(text.indexOf('gamma school')).toBeGreaterThan(text.indexOf('beta school'));
    } finally {
        await parkMouse(page);
    }
});

test('one deleted while it is saved in the settings is dropped without an error', async ({page}) => {
    await start(page, {dictionaryOrder: ['Long gone', 'Beta'], disabledDictionaries: ['Also long gone']});
    expect(await titlesInUse(page)).toEqual(['Beta', 'Mini', 'KanjiOnly']);
    expect(await known(page)).toEqual(['昨日', 'は', '学校', 'に', '行きませんでした']);
});

const directory = process.env.YOMITAN_REAL_DICTS;

test.describe('with real dictionaries', () => {
    test.skip(!directory, 'Needs YOMITAN_REAL_DICTS.');
    test.setTimeout(240_000);

    test.beforeAll(async () => {
        test.setTimeout(240_000);
        await deleteAll(admin);
        for (const file of ['JMdict_english.zip', 'JMnedict.zip', 'KANJIDIC_english.zip']) {
            const job = await importArchive(admin, readFileSync(join(directory, file)));
            expect(job.error).toBeNull();
        }
    });

    test('turning JMdict off with KANJIDIC on changes what the popup and the line can do', async ({page, isMobile}) => {
        test.skip(isMobile, 'The mouse is the short way.');
        await start(page);
        const titles = await titlesInUse(page);
        const jmdict = titles.find((title) => /^JMdict/.test(title));
        const jmnedict = titles.find((title) => /^JMnedict/.test(title));
        const kanjidic = titles.find((title) => /^KANJIDIC/.test(title));
        expect(await known(page)).toContain('学校');
        expect(await known(page)).toContain('行きませんでした');
        const full = await open(page, '学校');
        expect(full).toContain('school');
        expect(full).toContain('JMdict');
        expect(full).toContain('KANJIDIC');
        await parkMouse(page);
        await expect.poll(() => isPaused(page)).toBe(false);

        await setDictionaries(page, 'disabledDictionaries', [jmdict]);
        await expect.poll(() => known(page)).not.toContain('行きませんでした');
        await expect.poll(() => page.locator('.yomitan-lines .yomitan-word').count()).toBeGreaterThan(0);
        const names = await known(page);
        console.log('with JMnedict and KANJIDIC only, the line splits as', names);

        // Only names are left, so 学校 falls apart, and what a piece of it shows comes from the dictionaries that are on.
        expect(names).not.toContain('学校');
        const text = await open(page, '学');
        expect(text).not.toContain('JMdict');
        expect(text).toContain('JMnedict');
        expect(text).toContain('KANJIDIC');
        await parkMouse(page);
        await expect.poll(() => isPaused(page)).toBe(false);

        // KANJIDIC alone holds no words, so nothing can split a line, and the line goes back.
        await setDictionaries(page, 'disabledDictionaries', [jmdict, jmnedict]);
        await expect(page.locator('.yomitan-notice')).toContainText('hold no words');
        await expect.poll(() => page.locator('.yomitan-overlay').count()).toBe(0);
        await expect.poll(() => jellyfinLine(page)).toBe('showing');
        expect(await titlesInUse(page)).toEqual([kanjidic]);

        await setDictionaries(page, 'disabledDictionaries', [jmnedict]);
        await page.waitForFunction(() => window.__yomitanJellyfin.playback.session?.state === 'active');
        await showLine(page, LINES.plain);
        expect(await known(page)).toContain('行きませんでした');
    });
});
