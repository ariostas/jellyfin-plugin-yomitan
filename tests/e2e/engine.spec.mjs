// The engine against a real server: the bundle's trimming, the batching, and what happens when answers change.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from '@playwright/test';
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {openEngine} from '../lib/engine-page.mjs';
import {credentials} from '../lib/jellyfin.mjs';
import {makeMiniDictionary, miniDictionaryTitle} from '../lib/mini-dictionary.mjs';
import {bundleYomitan} from '../lib/yomitan.mjs';

const root = new URL('../../', import.meta.url).pathname;
let admin;

test.beforeAll(async () => {
    admin = await clientFor(credentials.username, credentials.password);
    await deleteAll(admin);
    expect((await importArchive(admin, makeMiniDictionary())).state).toBe('succeeded');
});

test.afterAll(async () => {
    await deleteAll(admin);
});

/** Counts the query requests a function makes in the page, and their sizes. */
async function countQueries(page, action) {
    const requests = [];
    const onRequest = (request) => {
        if (request.url().endsWith('/Yomitan/Query')) {
            requests.push(request.postDataJSON());
        }
    };
    page.on('request', onRequest);
    const result = await action();
    page.off('request', onRequest);
    return {requests, result};
}

test('the Japanese descriptor the bundle uses is Yomitan\'s own', () => {
    const original = readFileSync(join(root, 'third_party/yomitan/ext/js/language/language-descriptors.js'), 'utf8');
    const trimmed = readFileSync(join(root, 'client/src/engine/language-descriptors.js'), 'utf8');
    const entry = (source) => /iso: 'ja',[\s\S]*?languageTransforms: japaneseTransforms,/.exec(source)[0].replace(/\s+/g, ' ');
    expect(entry(trimmed)).toBe(entry(original));
});

test('the trimmed Translator gives what the full one does', async ({page}) => {
    await openEngine(page);
    await page.addScriptTag({content: await bundleYomitan()});

    const texts = [
        '食べられなかった', '行きませんでした', 'コーヒー', 'ｺｰﾋｰ', 'こーひー', 'すっごーい', '學校', 'gakkou', '1000円', '食べる', 'はコーヒー',
    ];
    const {trimmed, full} = await page.evaluate(async (list) => {
        const {Translator} = window.yomitan;
        const database = {
            findTermsBulk: async (terms, dictionaries, matchType) => {
                await window.engine.prefetch([]);
                return window.engine._database.findTermsBulk(terms, dictionaries, matchType);
            },
            findTermMetaBulk: () => [],
            findTagMetaBulk: (items) => items.map(() => undefined),
            getDictionaryInfo: () => window.engine.dictionaries,
        };
        const translator = new Translator(database);
        translator.prepare();
        const trimmedResults = [];
        const fullResults = [];
        for (const text of list) {
            trimmedResults.push(JSON.stringify((await window.engine.lookup(text, {mode: 'simple'})).dictionaryEntries));
            fullResults.push(JSON.stringify((await translator.findTerms('simple', text, window.engine._options)).dictionaryEntries));
        }

        return {trimmed: trimmedResults, full: fullResults};
    }, texts);
    expect(trimmed).toEqual(full);
    expect(trimmed.some((result) => result.includes('食べる'))).toBe(true);
});

test('the store answers exactly as the server does, including rows found under another term', async ({page}) => {
    await openEngine(page);
    const lists = [
        ['食べる', 'たべる', 'かう', 'コーヒー', 'こーひー'],
        ['たべる'],
        ['はこう', '跛行'],
        ['跛行', 'はこう'],
        ['いく', '行く', 'いく'],
        ['ない', 'ある'],
    ];

    const {stored, served} = await page.evaluate(async ({all, title}) => {
        // Fill the store from one merged list, in which rows are only reported under their first sighting.
        const merged = all.flat();
        await window.engine._terms.ensure(merged);
        return {
            stored: all.map((list) => window.engine._terms.read(list)),
            served: await Promise.all(all.map(async (list) => {
                const [{rows}] = await window.engine._client.send([{op: 'findTermsBulk', termList: list, dictionaries: [title], matchType: 'exact'}]);
                return rows;
            })),
        };
    }, {all: lists, title: miniDictionaryTitle});
    expect(stored).toEqual(served);
    expect(stored.flat().length).toBeGreaterThan(5);
});

test('a line costs one request the first time and none after', async ({page}) => {
    await openEngine(page);
    const text = '昨日は学校に行きませんでした';
    const first = await countQueries(page, () => page.evaluate((line) => window.segmenter.segment(line), text));
    expect(first.requests.length).toBe(1);
    expect(first.result.map(({text: word}) => word)).toEqual(['昨日', 'は', '学校', 'に', '行きませんでした']);

    const second = await countQueries(page, () => page.evaluate((line) => window.segmenter.segment(line), text));
    expect(second.requests.length).toBe(0);
    expect(second.result).toEqual(first.result);
    expect(await page.evaluate((line) => window.segmenter.peek(line)?.length, text)).toBe(first.result.length);
});

test('a full store starts over between lines, so a line never loses the rows it just asked for', async ({page}) => {
    await openEngine(page);
    const requests = await page.evaluate(async () => {
        const terms = window.engine._terms;
        const fetchTerms = terms._fetchTerms;

        // As if this very fetch had filled the store.
        terms._fetchTerms = async (list) => {
            const result = await fetchTerms(list);
            for (let id = -1; id > -40_000; id -= 1) {
                terms._rowIds.add(id);
            }

            return result;
        };
        const before = window.engine.requests;
        await window.segmenter.segment('友達と映画を見ました');
        return window.engine.requests - before;
    });
    expect(requests).toBe(1);
});

test('segmenting works in slices, so the page gets a turn', async ({page}) => {
    await openEngine(page);
    const turns = await page.evaluate(async () => {
        let count = 0;
        const {setTimeout: original} = window;
        window.setTimeout = function (callback, delay) {
            count += new Error('where').stack.includes('engine.js') ? 1 : 0;
            return original.call(this, callback, delay);
        };

        const text = '猫が窓の外を見ている子供たちが公園で遊んでいる友達と映画を見ました電車が遅れています';
        await window.segmenter.segment(text);
        window.setTimeout = original;
        return count;
    });
    expect(turns).toBeGreaterThanOrEqual(2);
});

test('a lookup after segmenting reuses the rows', async ({page}) => {
    await openEngine(page);
    await page.evaluate(() => window.segmenter.segment('食べられなかった'));
    const {requests, result} = await countQueries(page, () => page.evaluate(async () => {
        const {dictionaryEntries, originalTextLength, truncated} = await window.engine.lookup('食べられなかった');
        return {term: dictionaryEntries[0].headwords[0].term, originalTextLength, truncated, reasons: dictionaryEntries[0].inflectionRuleChainCandidates.length};
    }));
    expect(result).toEqual({term: '食べる', originalTextLength: 8, truncated: false, reasons: expect.any(Number)});
    expect(result.reasons).toBeGreaterThan(0);
    for (const {operations} of requests) {
        expect(operations.some(({op}) => op === 'findTermsBulk')).toBe(false);
    }
});

test('lookups repeat exactly, so nothing in the store was edited in place', async ({page}) => {
    await openEngine(page);
    const results = await page.evaluate(async () => {
        const run = async () => JSON.stringify((await window.engine.lookup('食べる')).dictionaryEntries);
        return [await run(), await run()];
    });
    expect(results[0]).toBe(results[1]);
});

test('kanji lookups reach the server', async ({page}) => {
    await openEngine(page);
    const entries = await page.evaluate(() => window.engine.lookupKanji('食'));
    expect(entries).toEqual([]);
});

test.describe('a cut-short answer', () => {
    /** Makes the server's answers to term queries look cut short, keeping only the first rows, while `active`. */
    async function truncateTermQueries(page, keepRows = 1) {
        const state = {active: true, requests: 0, sizes: []};
        await page.route('**/Yomitan/Query', async (route) => {
            const response = await route.fetch();
            const json = await response.json();
            const {operations} = route.request().postDataJSON();
            const terms = operations.findIndex(({op}) => op === 'findTermsBulk');
            if (terms >= 0) {
                state.requests += 1;
                state.sizes.push(operations[terms].termList.length);
                if (state.active) {
                    json.results[terms] = {rows: json.results[terms].rows.slice(0, keepRows), truncated: true};
                }
            }

            await route.fulfill({response, json});
        });
        return state;
    }

    test('is split and retried, and then the store fills in', async ({page}) => {
        await openEngine(page);
        const state = await truncateTermQueries(page);
        const words = await page.evaluate(() => window.segmenter.segment('昨日は学校に行きませんでした'));
        expect(state.requests).toBeGreaterThan(1);
        expect(state.sizes[1]).toBeLessThan(state.sizes[0]);
        expect(words.map(({text}) => text).join('')).toBe('昨日は学校に行きませんでした');

        // Nothing it said was kept as complete, so an honest answer now replaces it.
        state.active = false;
        await page.evaluate(() => window.segmenter.clear());
        const honest = await page.evaluate(() => window.segmenter.segment('昨日は学校に行きませんでした'));
        expect(honest.map(({text}) => text)).toEqual(['昨日', 'は', '学校', 'に', '行きませんでした']);
    });

    test('is not cached as complete, in the store or per line', async ({page}) => {
        await openEngine(page);
        const state = await truncateTermQueries(page);
        const line = '彼女はケーキを食べられなかった';
        await page.evaluate((text) => window.segmenter.segment(text), line);
        const after = await page.evaluate((text) => ({peek: window.segmenter.peek(text) ?? null, terms: window.engine.cacheSize.terms}), line);
        expect(after).toEqual({peek: null, terms: 0});

        const before = state.requests;
        await page.evaluate((text) => window.segmenter.segment(text), line);
        expect(state.requests).toBeGreaterThan(before);
    });

    test('marks a lookup as incomplete instead of failing', async ({page}) => {
        await openEngine(page);
        await truncateTermQueries(page);
        const {count, truncated} = await page.evaluate(async () => {
            const {dictionaryEntries, truncated: cut} = await window.engine.lookup('食べる');
            return {count: dictionaryEntries.length, truncated: cut};
        });
        expect(truncated).toBe(true);
        expect(count).toBeGreaterThanOrEqual(0);
    });
});

test.describe('when a dictionary is replaced', () => {
    test('everything keyed on row ids goes, and the new rows answer', async ({page}) => {
        const replaced = 'new-title-free';
        await openEngine(page);
        const line = '昨日は学校に行きませんでした';
        const before = await page.evaluate(async (text) => {
            await window.segmenter.segment(text);
            window.changes = 0;
            window.engine.addEventListener('dictionarieschange', () => {
                window.changes += 1;
                window.segmenter.clear();
            });
            const entries = (await window.engine.lookup('昨日')).dictionaryEntries;
            return entries[0].definitions[0].id;
        }, line);

        // A new dictionary with one extra row in front, so every id moves.
        const archive = makeMiniDictionary({extraTerms: [[replaced, replaced, 'n']]});
        expect((await importArchive(admin, archive, {replace: true})).state).toBe('succeeded');

        // Any request notices. This line uses a word the store has not seen, so it has to ask.
        const after = await page.evaluate(async (text) => {
            await window.engine.lookup('新しい言葉');
            const entries = (await window.engine.lookup('昨日')).dictionaryEntries;
            return {
                changes: window.changes,
                id: entries[0].definitions[0].id,
                glossary: entries[0].definitions[0].entries,
                peek: window.segmenter.peek(text) ?? null,
            };
        }, line);
        expect(after.changes).toBe(1);
        expect(after.peek).toBeNull();
        expect(after.id).not.toBe(before);
        expect(after.glossary).toEqual(['meaning of 昨日']);
    });

    test('every request carries the dictionary list, in the same snapshot', async ({page}) => {
        await openEngine(page);
        const {requests} = await countQueries(page, () => page.evaluate(() => window.segmenter.segment('猫と犬')));
        expect(requests.length).toBeGreaterThan(0);
        for (const {operations} of requests) {
            expect(operations.at(-1)).toEqual({op: 'getDictionaryInfo'});
        }
    });
});

test('an empty list costs no request', async ({page}) => {
    await openEngine(page);
    const {requests} = await countQueries(page, () => page.evaluate(() => window.engine._database.findTermsBulk([], new Map(), 'exact')));
    expect(requests.length).toBe(0);
});
