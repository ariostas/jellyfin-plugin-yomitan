// Compares the server with real Yomitan on the same archives. Yomitan's own importer and DictionaryDatabase
// run in Chromium on real IndexedDB, and nothing here states what a row looks like: the only expectation is
// whatever Yomitan produced.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from '@playwright/test';
import {clientFor, deleteAll, importArchive, yomitanTestData, zipTestDictionary} from '../lib/dictionaries.mjs';
import {credentials} from '../lib/jellyfin.mjs';
import {makeDictionary} from '../lib/zip.mjs';
import {openYomitan} from '../lib/yomitan-page.mjs';

const mainTitle = 'Test Dictionary';
const secondTitle = 'Second Dictionary';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="21" height="13"><rect width="21" height="13"/></svg>';

// Exercises what the first fixture leaves out: format 1 and 2, astral characters, tags in the index,
// doubled spaces, kana-only terms, every image field, and terms shared with the first dictionary.
const second = () => makeDictionary({
    title: secondTitle,
    format: 2,
    revision: 'two',
    sequenced: true,
    author: 'someone',
    url: 'https://example.com/',
    description: 'd',
    attribution: 'a',
    frequencyMode: 'rank-based',
    sourceLanguage: 'ja',
    targetLanguage: 'en',
    minimumYomitanVersion: '0.0.0.1',
    isUpdatable: true,
    indexUrl: 'https://example.com/index.json',
    downloadUrl: 'https://example.com/d.zip',
    tagMeta: {oldTag: {category: 'old', order: 1, notes: 'n', score: 2}, bareTag: {}},
}, {
    'term_bank_2.json': [
        ['打つ', 'うつ', 'tag  doubled', 'v5', 1.5, ['second glossary', {type: 'text', text: 'as text'}], 1000, 'P'],
        ['かな', '', '', '', -3, [['打つ', ['past']]], 1001, ''],
        ['𠮟る', 'しかる', '', 'v5', 0, ['astral'], 1002, ''],
        ['打𠮟', 'だしつ', '', '', 0, ['astral end'], 1002, ''],
        ['打ｱ', 'だあ', '', '', 0, ['halfwidth'], 1003, ''],
        ['画', 'が', '', '', 1e21, [
            {type: 'image', path: 'pic.png', width: 30, height: 20, title: 't', alt: 'a', description: 'd', pixelated: true, imageRendering: 'crisp-edges', appearance: 'monochrome', background: false, collapsed: true, collapsible: false},
            {type: 'structured-content', content: [
                'text',
                {tag: 'img', path: 'pic.svg', width: 2, height: 1, verticalAlign: 'middle', border: '1px solid', borderRadius: '2px', sizeUnits: 'em', data: {gone: 'yes'}},
                {tag: 'div', data: {kept: 'yes'}, style: {fontWeight: 'bold'}, lang: 'ja', content: {tag: 'a', href: '?query=x', content: {tag: 'img', path: 'pic.png'}}},
                {tag: 'br'},
            ]},
        ], 1004, ''],
    ],
    'term_meta_bank_1.json': [
        ['打つ', 'freq', 5],
        ['打つ', 'freq', {reading: 'うつ', frequency: {value: 2, displayValue: 'two'}}],
        ['打つ', 'pitch', {reading: 'うつ', pitches: [{position: 1, nasal: [1], devoice: 0, tags: ['x']}]}],
        ['打つ', 'ipa', {reading: 'うつ', transcriptions: [{ipa: 'utsɯ', tags: ['y']}]}],
    ],
    'kanji_bank_2.json': [['打', 'ダ', 'う.つ ぶ.つ', 'jouyou', ['hit'], {strokes: '5'}]],
    'kanji_meta_bank_2.json': [['打', 'freq', 'many'], ['打', 'freq', {value: 3, displayValue: 'three'}]],
    'tag_bank_1.json': [['tag', 'partOfSpeech', -1, 'a note', 0.5]],
    'tag_bank_2.json': [['tag', 'duplicate', 0, 'loses to the first', 0]],
    'pic.png': png,
    'pic.svg': svg,
    'unused.gif': 'not even an image',
    'styles.css': '.x { color: red; }',
});

const oldFormat = () => makeDictionary({title: 'Format One', version: 1, revision: 'one'}, {
    'term_bank_1.json': [['古', 'ふる', null, 'adj-i', 7], ['古', '', 'tag', '', 0]],
    'kanji_bank_1.json': [['古', 'コ', 'ふる.い', 'jouyou']],
});

/** Every op, on every string the fixtures hold and on fragments of them. */
function buildOperations(dictionaries, terms, readings, kanji, tags, sequences) {
    const strings = [...new Set([...terms, ...readings])];
    const fragments = [...new Set(strings.flatMap((text) => {
        const characters = [...text];
        return [characters[0], characters.at(-1), characters.slice(0, 2).join(''), characters.slice(-2).join('')];
    }))];
    const missing = ['存在しない', ''];
    const all = dictionaries;
    const operations = [];

    // What the Translator sends when it cuts 𠮟 in half. Yomitan finds no exact match for these. A prefix search
    // would match on the half character, which docs/api.md lists as a difference.
    const halves = ['\ud842', '\udfb7', '打\ud842'];
    operations.push(
        {op: 'findTermsBulk', termList: [...halves, '打つ'], dictionaries: all, matchType: 'exact'},
        {op: 'findTermsExactBulk', termList: [{term: '\ud842', reading: 'x'}, {term: '打つ', reading: 'うつ'}], dictionaries: all},
        {op: 'findTermMetaBulk', termList: [...halves, '打つ'], dictionaries: all},
        {op: 'findKanjiBulk', kanjiList: [...halves, '打'], dictionaries: all},
        {op: 'findKanjiMetaBulk', kanjiList: [...halves, '打'], dictionaries: all},
        {op: 'findTagMetaBulk', items: [{query: '\ud842', dictionary: all[0]}, {query: tags[0], dictionary: all[0]}]},
    );

    for (const matchType of ['exact', 'prefix', 'suffix']) {
        // One large list, so visited interacts across items, and each item alone, so order is seen per item. The server
        // refuses an empty prefix or suffix, which the Translator never sends: see docs/api.md.
        const list = [...strings, ...fragments, ...missing].filter((text) => matchType === 'exact' || text !== '');
        operations.push({op: 'findTermsBulk', termList: list, dictionaries: all, matchType});
        operations.push({op: 'findTermsBulk', termList: [...list].reverse(), dictionaries: all, matchType});
        for (const text of list) {
            operations.push({op: 'findTermsBulk', termList: [text], dictionaries: all, matchType});
        }

        for (const dictionary of all) {
            operations.push({op: 'findTermsBulk', termList: list, dictionaries: [dictionary], matchType});
        }
    }

    const pairs = strings.flatMap((term) => readings.map((reading) => ({term, reading})));
    operations.push({op: 'findTermsExactBulk', termList: pairs, dictionaries: all});
    operations.push({op: 'findTermsExactBulk', termList: pairs, dictionaries: [all[0]]});
    operations.push({op: 'findTermsBySequenceBulk', items: all.flatMap((dictionary) => [...sequences, -1, 0, 999999].map((query) => ({query, dictionary})))});
    operations.push({op: 'findTermMetaBulk', termList: [...strings, ...missing], dictionaries: all});
    operations.push({op: 'findKanjiBulk', kanjiList: [...kanji, ...fragments, '無'], dictionaries: all});
    operations.push({op: 'findKanjiMetaBulk', kanjiList: [...kanji, ...fragments, '無'], dictionaries: all});
    operations.push({op: 'findTagMetaBulk', items: all.flatMap((dictionary) => [...tags, 'nothing'].map((query) => ({query, dictionary})))});
    operations.push({op: 'findTagMetaBulk', items: [{query: tags[0], dictionary: 'No Such Dictionary'}]});
    operations.push({op: 'getDictionaryInfo'});
    return operations;
}

/** Ids only have to agree relative to each server's first row, since other specs have used up server ids. */
function normalize(results, firstId) {
    return structuredClone(results).map((rows) => rows.map((row) => {
        if (row && typeof row.id === 'number') {
            row.id -= firstId;
        }

        if (row && typeof row.importDate === 'number') {
            row.importDate = 0;
        }

        return row;
    }));
}

function collect(results, key) {
    const values = new Set();
    for (const rows of results) {
        for (const row of rows) {
            if (row?.[key] !== undefined) {
                values.add(row[key]);
            }
        }
    }

    return [...values];
}

test.describe.configure({mode: 'serial'});

let yomitan;
let client;

test.beforeAll(async ({browser}) => {
    test.setTimeout(180_000);
    client = await clientFor(credentials.username, credentials.password);
    await deleteAll(client);

    yomitan = await openYomitan(await browser.newContext());
    const archives = [
        ['main', zipTestDictionary('valid-dictionary1')],
        ['second', second()],
        ['old', oldFormat()],
    ];
    for (const [name, archive] of archives) {
        const {result, errors} = await yomitan.importDictionary(name, archive);
        expect(errors).toEqual([]);
        expect(result).not.toBeNull();
        expect((await importArchive(client, archive)).error).toBeNull();
    }
});

test.afterAll(async () => {
    await yomitan?.context.close();
    await deleteAll(client);
});

async function serverRows(operations) {
    const chunks = [];
    let chunk = [];
    let size = 0;
    const sizeOf = (operation) => (operation.termList ?? operation.kanjiList ?? operation.items ?? []).length;
    for (const operation of operations) {
        if (chunk.length === 32 || size + sizeOf(operation) > 2000) {
            chunks.push(chunk);
            chunk = [];
            size = 0;
        }

        chunk.push(operation);
        size += sizeOf(operation);
    }

    chunks.push(chunk);
    const rows = [];
    for (const operations of chunks) {
        const response = await client.query(operations);
        expect(response.status).toBe(200);
        const {results} = await response.json();
        for (const {rows: resultRows, truncated} of results) {
            expect(truncated).toBe(false);
            rows.push(resultRows);
        }
    }

    return rows;
}

test('every operation returns exactly what DictionaryDatabase returns', async () => {
    test.setTimeout(180_000);
    const dictionaries = [mainTitle, secondTitle, 'Format One'];
    const seed = await yomitan.run([{op: 'findTermsBulk', termList: [''], dictionaries, matchType: 'prefix'}]);
    const terms = collect(seed, 'term');
    const readings = collect(seed, 'reading');
    const sequences = collect(seed, 'sequence').filter((sequence) => sequence !== -1);
    expect(terms.length).toBeGreaterThan(30);

    const tagBanks = ['tag_bank_1.json', 'tag_bank_2.json', 'tag_bank_3.json'].flatMap((file) =>
        JSON.parse(readFileSync(join(yomitanTestData, 'dictionaries/valid-dictionary1', file), 'utf8')).map(([name]) => name));
    const tags = [...new Set([...tagBanks, 'tag', 'oldTag', 'bareTag'])];
    const kanji = ['打', '込', '画', '古'];

    const operations = buildOperations(dictionaries, terms, readings, kanji, tags, sequences);
    const real = await yomitan.run(operations);
    const served = await serverRows(operations);

    // A comparison of empty results would prove nothing, so make sure each op really found something.
    const found = {};
    operations.forEach(({op, matchType}, i) => {
        const key = matchType ? `${op}:${matchType}` : op;
        found[key] = (found[key] ?? 0) + real[i].length;
    });
    for (const [key, count] of Object.entries(found)) {
        expect(count, key).toBeGreaterThan(0);
    }

    const realFirst = Math.min(...collect(seed, 'id'));
    // Every row is under one of the seed's terms. The server refuses the empty prefix that found them in Yomitan.
    const [servedSeed] = await serverRows([{op: 'findTermsBulk', termList: terms, dictionaries, matchType: 'exact'}]);
    expect(servedSeed).toHaveLength(seed[0].length);
    const servedFirst = Math.min(...collect([servedSeed], 'id'));

    const a = normalize(real, realFirst);
    const b = normalize(served, servedFirst);
    for (let i = 0; i < operations.length; i++) {
        expect(b[i], `operation ${i}: ${JSON.stringify(operations[i]).slice(0, 300)}`).toEqual(a[i]);
    }

    // toEqual would pass a missing key against an undefined one, and ignores key order. Key order is
    // not significant to any caller, but a stricter check on the key sets costs nothing.
    const keys = (value) => JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1))) : v));
    expect(keys(b)).toBe(keys(a));
});

test('images: stored dimensions match what the browser decoded', async () => {
    const operations = [{op: 'findTermsBulk', termList: ['画'], dictionaries: [secondTitle], matchType: 'exact'}];
    const [[real]] = await yomitan.run(operations);
    expect(real.definitions[0].width).toBe(3);
    expect(real.definitions[0].height).toBe(2);
    expect(real.definitions[1].content[1].width).toBe(21);
    expect(real.definitions[1].content[1].height).toBe(13);
    const [[served]] = await serverRows(operations);
    expect(served.definitions).toEqual(real.definitions);
});

test('the Translator gives the same results on the server as on IndexedDB', async () => {
    test.setTimeout(120_000);
    const {optionsPresets, tests} = JSON.parse(readFileSync(join(yomitanTestData, 'translator-test-inputs.json'), 'utf8'));
    const calls = tests.map(({name, func, mode, text, options}) => ({
        name,
        func,
        mode,
        text,
        options: {
            create: func === 'findTerms' ? 'createFindTermsOptions' : 'createFindKanjiOptions',
            args: [mainTitle, optionsPresets, options],
        },
    }));
    expect(calls.length).toBeGreaterThan(40);

    const query = async (operations) => (await (await client.query(operations)).json()).results;
    const results = await yomitan.translate(calls, query);

    const ignoreIds = (text) => text.replaceAll(/"(id|ids|definitionIds)":(\d+|\[[\d,]*\])/g, '"$1":0');
    for (const {name, real, served} of results) {
        expect(ignoreIds(served), name).toBe(ignoreIds(real));
    }

    // Not an all-empty comparison.
    expect(results.filter(({real}) => real.length > 100).length).toBeGreaterThan(30);
});

test('the pinned Yomitan version the importer reports is the submodule\'s', () => {
    const root = new URL('../../', import.meta.url).pathname;
    const git = (...args) => execFileSync('git', ['-C', join(root, 'third_party/yomitan'), ...args], {encoding: 'utf8'}).trim();
    const source = readFileSync(join(root, 'src/Jellyfin.Plugin.Yomitan/Dictionaries/DictionaryImporter.cs'), 'utf8');
    const version = /YomitanVersion = "([^"]+)"/.exec(source)[1];

    // CI checks the submodule out shallow and without tags, so ask Yomitan's repository which commit the tag names.
    const remote = git('ls-remote', 'origin', `refs/tags/${version}`, `refs/tags/${version}^{}`).split('\n');
    const tagged = (remote.find((line) => line.endsWith('^{}')) ?? remote[0]).split('\t')[0];
    expect(tagged, `no tag ${version} in Yomitan's repository`).toBeTruthy();
    expect(git('rev-parse', 'HEAD')).toBe(tagged);
});
