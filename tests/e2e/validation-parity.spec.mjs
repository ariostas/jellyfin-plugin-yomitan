// The server validates with its own small interpreter of Yomitan's schemas. Real ajv, set up as in Yomitan's
// dev/build-libs.js, decides what each case below should do, and the server has to reach the same verdict.
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from '@playwright/test';
import Ajv from 'ajv';
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {credentials} from '../lib/jellyfin.mjs';
import {makeZip} from '../lib/zip.mjs';

const schemaDirectory = new URL('../../third_party/yomitan/ext/data/schemas/', import.meta.url).pathname;
const schemas = readdirSync(schemaDirectory).map((file) => JSON.parse(readFileSync(join(schemaDirectory, file), 'utf8')));
const ajv = new Ajv({schemas, allowUnionTypes: true});
const validator = (id) => ajv.getSchema(id);

const term = (definition) => ['語', 'ご', '', '', 0, [definition], 1, ''];
const content = (node) => term({type: 'structured-content', content: node});

const termV3 = [
    ['語', 'ご', '', '', 0, [], 1, ''],
    ['語', 'ご', null, '', 0, [], 1, ''],
    ['語', 'ご', '', null, 0, [], 1, ''],
    ['語', 'ご', '', '', 1.5, [], 1, ''],
    ['語', 'ご', '', '', -1, [], 1.5, ''],
    ['語', 'ご', '', '', 0, [], 1],
    ['語', 'ご', '', '', 0, [], 1, '', 'extra'],
    ['語', 1, '', '', 0, [], 1, ''],
    ['語', 'ご', '', '', '0', [], 1, ''],
    term('text'),
    term(1),
    term(null),
    term(true),
    term({}),
    term({type: 'text', text: 'x'}),
    term({type: 'text'}),
    term({type: 'text', text: 'x', extra: 1}),
    term({type: 'text', content: 'x'}),
    term({type: 'audio', path: 'a'}),
    term({type: 'image'}),
    term({type: 'image', path: 'x.png', width: 0}),
    term({type: 'image', path: 'x.png', width: 1.5}),
    term({type: 'image', path: 'x.png', imageRendering: 'blurry'}),
    term({type: 'image', path: 'x.png', appearance: 'monochrome'}),
    term({type: 'image', path: 'x.png', extra: 1}),
    term(['base', ['rule']]),
    term(['base']),
    term(['base', 'rule']),
    term(['base', ['rule'], 'extra']),
    term([1, ['rule']]),
    content('text'),
    content(1),
    content(null),
    content([]),
    content(['a', ['b', ['c']]]),
    content({}),
    content({tag: 'br'}),
    content({tag: 'br', content: 'x'}),
    content({tag: 'br', data: {a: 'b'}}),
    content({tag: 'br', data: {a: 1}}),
    content({tag: 'script', content: 'alert(1)'}),
    content({tag: 'div', content: 'x', lang: 'ja'}),
    content({tag: 'div', content: 'x', style: {fontWeight: 'bold', fontSize: '12px'}}),
    content({tag: 'div', style: {fontWeight: 'heavier'}}),
    content({tag: 'div', style: {unknownProperty: 'x'}}),
    content({tag: 'span', style: {textDecorationLine: ['underline', 'overline']}}),
    content({tag: 'span', style: {textDecorationLine: ['blink']}}),
    content({tag: 'span', title: 'x', open: true}),
    content({tag: 'details', open: true, content: 'x'}),
    content({tag: 'ruby', content: ['a', {tag: 'rt', content: 'b'}]}),
    content({tag: 'table', content: {tag: 'tr', content: {tag: 'td', colSpan: 2, rowSpan: 0, content: 'x'}}}),
    content({tag: 'td', colSpan: 0}),
    content({tag: 'td', colSpan: 1, style: {fontStyle: 'italic'}}),
    content({tag: 'a', href: 'https://example.com'}),
    content({tag: 'a', href: '?query=x'}),
    content({tag: 'a', href: 'javascript:alert(1)'}),
    content({tag: 'a'}),
    content({tag: 'img'}),
    content({tag: 'img', path: 'x.png', width: 1.5}),
    content({tag: 'img', path: 'x.png', width: 0}),
    content({tag: 'img', path: 'x.png', sizeUnits: 'px'}),
    content({tag: 'img', path: 'x.png', sizeUnits: 'em', verticalAlign: 'middle'}),
    content({tag: 'img', path: 'x.png', verticalAlign: 'sideways'}),
    content({tag: 'img', path: 'x.png', content: 'x'}),
];

const termMeta = [
    ['語', 'freq', 1],
    ['語', 'freq', 'many'],
    ['語', 'freq', {value: 1}],
    ['語', 'freq', {value: '1'}],
    ['語', 'freq', {value: 1, displayValue: 'one'}],
    ['語', 'freq', {value: 1, extra: 1}],
    ['語', 'freq', {reading: 'ご', frequency: 1}],
    ['語', 'freq', {reading: 'ご', frequency: {value: 1}}],
    ['語', 'freq', {reading: 'ご'}],
    ['語', 'freq', true],
    ['語', 'freq', null],
    ['語', 'pitch', {reading: 'ご', pitches: []}],
    ['語', 'pitch', {reading: 'ご', pitches: [{position: 1}]}],
    ['語', 'pitch', {reading: 'ご', pitches: [{position: 'HL'}]}],
    ['語', 'pitch', {reading: 'ご', pitches: [{position: 'HLX'}]}],
    ['語', 'pitch', {reading: 'ご', pitches: [{position: 'HL\n'}]}],
    ['語', 'pitch', {reading: 'ご', pitches: [{position: -1}]}],
    ['語', 'pitch', {reading: 'ご', pitches: [{position: 1.5}]}],
    ['語', 'pitch', {reading: 'ご', pitches: [{position: 1, nasal: [1, 2], devoice: 0, tags: ['a']}]}],
    ['語', 'pitch', {reading: 'ご', pitches: [{position: 1, nasal: -1}]}],
    ['語', 'pitch', {reading: 'ご', pitches: [{nasal: 1}]}],
    ['語', 'pitch', {pitches: []}],
    ['語', 'ipa', {reading: 'ご', transcriptions: [{ipa: 'go'}]}],
    ['語', 'ipa', {reading: 'ご', transcriptions: [{ipa: 'go', tags: ['a']}]}],
    ['語', 'ipa', {reading: 'ご', transcriptions: [{tags: []}]}],
    ['語', 'speed', 1],
    ['語', 'freq'],
    ['語', 'freq', 1, 2],
];

const kanjiV3 = [
    ['語', 'ゴ', 'かた.る', '', ['word'], {}],
    ['語', 'ゴ', 'かた.る', '', ['word'], {strokes: '14'}],
    ['語', 'ゴ', 'かた.る', '', ['word'], {strokes: 14}],
    ['語', 'ゴ', 'かた.る', '', 'word', {}],
    ['語', 'ゴ', 'かた.る', '', [1], {}],
    ['', 'ゴ', 'かた.る', '', ['word'], {}],
    ['語', 'ゴ', 'かた.る', '', ['word']],
    ['語', 'ゴ', 'かた.る', '', ['word'], {}, 'extra'],
];

const kanjiMeta = [
    ['語', 'freq', 1],
    ['語', 'freq', 'many'],
    ['語', 'freq', {value: 1, displayValue: 'one'}],
    ['語', 'pitch', 1],
    ['', 'freq', 1],
];

const tags = [
    ['n', 'c', 1, 'x', 2],
    ['n', 'c', 1.5, 'x', -2],
    ['', '', 0, '', 0],
    ['n', 'c', '1', 'x', 2],
    ['n', 'c', 1, 'x'],
    ['n', 'c', 1, 'x', 2, 3],
    [1, 'c', 1, 'x', 2],
];

const termV1 = [
    ['語', 'ご', '', '', 0],
    ['語', 'ご', null, '', 0],
    ['語', 'ご', '', '', 0, 'a definition'],
    ['語', '', '', '', 0],
    ['語', 'ご', '', ''],
];

const kanjiV1 = [
    ['語', 'ゴ', 'かた.る', ''],
    ['語', 'ゴ', 'かた.る', '', 'a meaning'],
    ['', 'ゴ', 'かた.る', ''],
];

const banks = [
    {file: 'term_bank_1.json', schema: 'dictionaryTermBankV3', rows: termV3, format: 3},
    {file: 'term_meta_bank_1.json', schema: 'dictionaryTermMetaBankV3', rows: termMeta, format: 3},
    {file: 'kanji_bank_1.json', schema: 'dictionaryKanjiBankV3', rows: kanjiV3, format: 3},
    {file: 'kanji_meta_bank_1.json', schema: 'dictionaryKanjiMetaBankV3', rows: kanjiMeta, format: 3},
    {file: 'tag_bank_1.json', schema: 'dictionaryTagBankV3', rows: tags, format: 3},
    {file: 'term_bank_1.json', schema: 'dictionaryTermBankV1', rows: termV1, format: 1},
    {file: 'kanji_bank_1.json', schema: 'dictionaryKanjiBankV1', rows: kanjiV1, format: 1},
];

const indexes = [
    {title: 'T', revision: '1', format: 3},
    {title: 'T', revision: '1', version: 3},
    {title: 'T', revision: '1', format: 2},
    {title: 'T', revision: '1', format: 1},
    {title: 'T', revision: '1', format: 0},
    {title: 'T', revision: '1', format: 4},
    {title: 'T', revision: '1', format: '3'},
    {title: 'T', revision: 1, format: 3},
    {title: 'T', revision: '1'},
    {revision: '1', format: 3},
    {title: 'T', revision: '1', format: 3, sequenced: 'yes'},
    {title: 'T', revision: '1', format: 3, sourceLanguage: 'ja'},
    {title: 'T', revision: '1', format: 3, sourceLanguage: 'japanese'},
    {title: 'T', revision: '1', format: 3, frequencyMode: 'rank-based'},
    {title: 'T', revision: '1', format: 3, frequencyMode: 'made-up'},
    {title: 'T', revision: '1', format: 3, unknownField: true},
    {title: 'T', revision: '1', format: 3, isUpdatable: false},
    {title: 'T', revision: '1', format: 3, tagMeta: {a: {category: 'c', order: 1}}},
    {title: 'T', revision: '1', format: 3, tagMeta: {a: {extra: 1}}},
];

// A valid row can still fail for a reason that has nothing to do with the schema: its image is missing here.
const needsMissingImage = (row) => JSON.stringify(row).includes('x.png');

const client = () => clientFor(credentials.username, credentials.password);

test('every row gets the verdict real ajv gives it', async () => {
    test.setTimeout(240_000);
    const admin = await client();
    await deleteAll(admin);

    const mismatches = [];
    let accepted = 0;
    let refused = 0;
    let number = 0;
    for (const {file, schema, rows, format} of banks) {
        for (const row of rows) {
            const expected = validator(schema)([row]);
            const title = `case-${number++}`;
            const job = await importArchive(admin, makeZip([
                {name: 'index.json', data: JSON.stringify({title, format, revision: '1'})},
                {name: file, data: JSON.stringify([row])},
            ]));

            const isSchemaFailure = job.error?.code === 'invalid_bank';
            const valid = !isSchemaFailure;
            if (valid !== expected) {
                mismatches.push(`${schema} ${JSON.stringify(row)}: ajv says ${expected}, server says ${job.error?.message ?? 'valid'}`);
            }

            if (expected && needsMissingImage(row)) {
                expect(job.error?.code, JSON.stringify(row)).toBe('invalid_media');
            } else if (expected) {
                expect(job.error, JSON.stringify(row)).toBeNull();
            }

            expected ? accepted++ : refused++;
        }

        await deleteAll(admin);
    }

    console.log(`${accepted} rows valid and ${refused} invalid according to ajv`);
    expect(mismatches).toEqual([]);
    expect(accepted).toBeGreaterThan(30);
    expect(refused).toBeGreaterThan(30);
});

test('every index gets the verdict real ajv gives it', async () => {
    test.setTimeout(60_000);
    const admin = await client();
    await deleteAll(admin);

    const mismatches = [];
    for (const index of indexes) {
        const expected = validator('dictionaryIndex')(index);
        const job = await importArchive(admin, makeZip([{name: 'index.json', data: JSON.stringify(index)}]));
        if ((job.error === null) !== expected) {
            mismatches.push(`${JSON.stringify(index)}: ajv says ${expected}, server says ${job.error?.message ?? 'valid'}`);
        }

        await deleteAll(admin);
    }

    expect(mismatches).toEqual([]);
});
