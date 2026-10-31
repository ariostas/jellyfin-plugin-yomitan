// A dictionary with one of everything the popup has to draw. Real dictionaries come in through YOMITAN_REAL_DICTS, and
// popup-real.spec.mjs uses them. This one is here so the rendering is tested on every run, with images, which no
// openly licensed Japanese dictionary at hand has.
import {PNG} from './hostile-dictionary.mjs';
import {makeZip} from './zip.mjs';

export const richDictionaryTitle = 'Rich';

const STYLES = `
.gloss-sc-div[data-sc-kind="note"] { color: rgb(10, 20, 30); }
.gloss-sc-span[data-sc-kind="badge"]::before { content: attr(data-sc-label); }
`;

const entry = (name, value) => ({name, data: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))});

export function makeRichDictionary() {
    const structured = {
        type: 'structured-content',
        content: [
            {tag: 'div', data: {kind: 'note'}, content: 'words at the bottom of a film'},
            {tag: 'span', data: {kind: 'badge', label: 'badge text'}, content: ''},
            {tag: 'ruby', content: ['字', {tag: 'rt', content: 'じ'}]},
            {tag: 'details', content: [{tag: 'summary', content: 'more'}, 'hidden detail']},
            {tag: 'table', content: [{tag: 'tr', content: [{tag: 'th', content: 'head'}, {tag: 'td', content: 'cell'}]}]},
            {tag: 'ul', content: [{tag: 'li', content: 'first item'}, {tag: 'li', content: 'second item'}]},
            {tag: 'img', path: 'pic.png', width: 3, height: 2, title: 'a tiny picture'},
        ],
    };
    return makeZip([
        entry('index.json', {title: richDictionaryTitle, format: 3, revision: 'r1', sequenced: true, frequencyMode: 'rank-based', author: 'Tests'}),
        entry('term_bank_1.json', [
            ['字幕', 'じまく', 'n P', '', 100, [structured, 'a plain gloss'], 1, 'P'],
            ['絵', 'え', 'n', '', 0, [{type: 'image', path: 'pic.png', width: 3, height: 2}, {type: 'image', path: 'pic2.png', width: 3, height: 2}, 'a picture'], 2, ''],
        ]),
        entry('term_meta_bank_1.json', [
            ['字幕', 'freq', {reading: 'じまく', frequency: {value: 1234, displayValue: '1.2k'}}],
            ['字幕', 'pitch', {reading: 'じまく', pitches: [{position: 0, nasal: [2], devoice: [1], tags: ['P']}, {position: 2}]}],
            ['字', 'freq', 42],
        ]),
        entry('kanji_bank_1.json', [
            ['字', 'ジ', 'あざ', 'P', ['character', 'letter'], {strokes: '6'}],
            ['幕', 'マク バク', '', '', ['curtain', 'act of a play'], {strokes: '13'}],
        ]),
        entry('kanji_meta_bank_1.json', [['字', 'freq', 300]]),
        entry('tag_bank_1.json', [['n', 'partOfSpeech', 0, 'noun', 0], ['P', 'popular', -5, 'popular term', 10], ['strokes', 'misc', 0, 'stroke count', 0]]),
        entry('styles.css', STYLES),
        {name: 'pic.png', data: PNG},
        {name: 'pic2.png', data: PNG},
    ]);
}
