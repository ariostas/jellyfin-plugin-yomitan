// The Phase 2 exit check: real dictionaries, the real Translator, a fixed word list. It needs the dictionaries,
// which are not in this repository, so it only runs with YOMITAN_REAL_DICTS set to a directory holding them.
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium, expect, test} from '@playwright/test';
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {credentials} from '../lib/jellyfin.mjs';
import {openYomitan} from '../lib/yomitan-page.mjs';

const directory = process.env.YOMITAN_REAL_DICTS;
const files = ['JMdict_english.zip', 'JMnedict.zip', 'KANJIDIC_english.zip'];

const sentences = [
    '食べられなかった', '行きませんでした', '彼女はケーキを食べました', '日本語を勉強しています', '学校へ行く', '猫が好きです',
    '私は東京に住んでいる', '読んでください', '見ることができる', '飲みたくない', '言われてしまった', 'ありがとうございます',
    'すみません、もう一度お願いします', 'コーヒーを飲みに行こう', '明日は雨が降るらしい', '走り出した', '美しかった',
    '静かな部屋', '勉強させられた', '書いておく', '持って来て', '𠮟られる', 'ｶﾀｶﾅ', 'ﾊﾟｿｺﾝ', 'たべる', 'ニホン', '山田太郎', '東京都',
    '吾輩は猫である。名前はまだ無い。', 'どこで生れたかとんと見当がつかぬ。', '国境の長いトンネルを抜けると雪国であった。',
];
const kanji = ['食', '語', '学', '𠮟', '鬱', '一'];

// Taken from Yomitan's own "default" preset in test/data/translator-test-inputs.json, with real titles.
function termOptions(main, titles) {
    return {
        matchType: 'exact',
        deinflect: true,
        mainDictionary: main,
        sortFrequencyDictionary: null,
        sortFrequencyDictionaryOrder: 'descending',
        removeNonJapaneseCharacters: true,
        language: 'ja',
        textReplacements: [null],
        enabledDictionaryMap: titles.map((title, index) => [title, {index, alias: title, allowSecondarySearches: false, partsOfSpeechFilter: true, useDeinflections: true}]),
        excludeDictionaryDefinitions: null,
        primaryReading: '',
        searchResolution: 'letter',
    };
}

test.describe.configure({mode: 'serial'});
test.skip(!directory, 'YOMITAN_REAL_DICTS is not set');

let yomitan;
let client;
let titles;
let profile;

test.beforeAll(async () => {
    test.setTimeout(1_800_000);
    client = await clientFor(credentials.username, credentials.password);
    await deleteAll(client);
    profile = mkdtempSync(join(tmpdir(), 'yomitan-parity-'));
    yomitan = await openYomitan(await chromium.launchPersistentContext(profile));
    titles = [];
    for (const file of files) {
        const archive = readFileSync(join(directory, file));

        const browserStart = Date.now();
        const {result, errors} = await yomitan.importDictionary(file, archive);
        const browserSeconds = (Date.now() - browserStart) / 1000;
        expect(errors).toEqual([]);

        const start = Date.now();
        const job = await importArchive(client, archive);
        expect(job.error).toBeNull();
        const seconds = (Date.now() - start) / 1000;
        console.log(`${file}: server ${seconds}s, Yomitan in Chromium ${browserSeconds}s, ${JSON.stringify(job.result.counts)}, ${job.result.sizeBytes} bytes`);

        expect(job.result.counts).toEqual(result.counts);
        titles.push(result.title);
    }
});

test.afterAll(async () => {
    await yomitan?.context.close();
    rmSync(profile, {recursive: true, force: true});
    await deleteAll(client);
});

test('the Translator agrees on a fixed word list, in every result mode', async () => {
    test.setTimeout(600_000);
    const [jmdict, jmnedict, kanjidic] = titles;
    const calls = [];
    for (const text of sentences) {
        for (const mode of ['simple', 'split', 'group', 'merge']) {
            // The options go through Yomitan's own test helper, which wants its presets format.
            const presets = {real: {type: 'terms', ...termOptions(jmdict, [jmdict, jmnedict])}};
            calls.push({
                name: `${mode}: ${text}`,
                func: 'findTerms',
                mode,
                text,
                options: {create: 'createFindTermsOptions', args: [jmdict, presets, 'real']},
            });
        }
    }

    for (const text of kanji) {
        const presets = {real: {type: 'kanji', enabledDictionaryMap: [[kanjidic, {index: 0, alias: kanjidic}]], removeNonJapaneseCharacters: false}};
        calls.push({name: `kanji: ${text}`, func: 'findKanji', text, options: {create: 'createFindKanjiOptions', args: [kanjidic, presets, 'real']}});
    }

    const query = async (operations) => (await (await client.query(operations)).json()).results;
    const results = await yomitan.translate(calls, query);

    const ignoreIds = (text) => text.replaceAll(/"(id|ids|definitionIds)":(\d+|\[[\d,]*\])/g, '"$1":0');
    let different = 0;
    for (const {name, real, served} of results) {
        if (ignoreIds(real) !== ignoreIds(served)) {
            different++;
            console.log(`DIFFERENT: ${name}`);
        }
    }

    const found = results.filter(({real}) => real.includes('"headwords"') || real.includes('"character"')).length;
    console.log(`${results.length} Translator calls compared, ${found} with results, ${different} different`);
    expect(different).toBe(0);
    expect(found).toBeGreaterThan(results.length * 0.9);
});

test('every operation agrees on terms sampled across the dictionaries', async () => {
    test.setTimeout(600_000);
    const [jmdict, jmnedict, kanjidic] = titles;
    const all = [jmdict, jmnedict];
    const seeds = ['日本', '食べ', '学', 'あい', 'かな', 'カタ', '東京', '山田', '𠮟'];
    const [seed] = await yomitan.run([{op: 'findTermsBulk', termList: seeds, dictionaries: all, matchType: 'prefix'}]);
    const sample = seed.filter((_, i) => i % 17 === 0).slice(0, 800);
    const terms = [...new Set(sample.map(({term}) => term))];
    const readings = [...new Set(sample.map(({reading}) => reading))];
    console.log(`${seed.length} rows seeded, ${terms.length} terms and ${readings.length} readings sampled`);

    const ends = [...new Set(terms.map((term) => [...term].slice(-3).join('')))].filter((end) => [...end].length === 3).slice(0, 200);
    const operations = [
        {op: 'findTermsBulk', termList: [...terms, ...readings], dictionaries: all, matchType: 'exact'},
        {op: 'findTermsBulk', termList: [...readings, ...terms].reverse(), dictionaries: [jmdict], matchType: 'exact'},
        {op: 'findTermsBulk', termList: terms.slice(0, 100), dictionaries: all, matchType: 'prefix'},
        {op: 'findTermsBulk', termList: ends, dictionaries: all, matchType: 'suffix'},
        {op: 'findTermsExactBulk', termList: sample.map(({term, reading}) => ({term, reading})), dictionaries: all},
        {op: 'findTermsBySequenceBulk', items: sample.filter(({sequence}) => sequence > 0).map(({sequence, dictionary}) => ({query: sequence, dictionary}))},
        {op: 'findKanjiBulk', kanjiList: ['食', '語', '学', '鬱', '一', '𠮟'], dictionaries: [kanjidic]},
        {op: 'findTagMetaBulk', items: [...new Set(sample.flatMap((row) => [...row.definitionTags, ...row.termTags]))].flatMap((query) => all.map((dictionary) => ({query, dictionary})))},
        {op: 'getDictionaryInfo'},
    ];

    const real = await yomitan.run(operations);
    const rowsById = new Map();
    for (let i = 0; i < operations.length; i++) {
        const {results: [{rows, truncated}]} = await (await client.query([operations[i]])).json();
        const label = `${operations[i].op} ${operations[i].matchType ?? ''}`;
        expect(truncated, label).toBe(false);
        expect(rows.length, label).toBe(real[i].length);
        console.log(`${label}: ${rows.length} rows`);

        // Ids on the two sides were assigned by different imports, so map one to the other by first sight.
        const strip = (row) => {
            if (!row) {
                return row;
            }

            const {id, importDate, ...rest} = row;
            return rest;
        };
        for (let j = 0; j < rows.length; j++) {
            if (rows[j]?.id !== undefined) {
                const known = rowsById.get(real[i][j].id);
                expect(known ?? rows[j].id, label).toBe(rows[j].id);
                rowsById.set(real[i][j].id, rows[j].id);
            }
        }

        expect(rows.map(strip), label).toEqual(real[i].map(strip));
    }
});
