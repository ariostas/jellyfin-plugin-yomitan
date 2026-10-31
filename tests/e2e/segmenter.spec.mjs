// The segmenter's rules against a fake dictionary, so each rule shows on its own. segmentation-real.spec.mjs runs the
// real thing.
import {expect, test} from '@playwright/test';
import {
    candidatesFrom, lastKanaBoundary, respectsKanaBoundary, segmentText, splitRuns,
} from '../../client/src/segmenter.js';

/** Returns entries as the Translator would, for each listed surface form that starts the window. */
function fakeScan(forms) {
    return async (window) => Object.entries(forms)
        .filter(([surface]) => window.startsWith(surface))
        .map(([surface, term]) => ({
            headwords: [{term, reading: term, sources: [{originalText: surface}]}],
        }));
}

const split = async (text, forms) => (await segmentText(text, fakeScan(forms))).map((word) => word.text).join('/');

test('the longest match wins among equals', async () => {
    expect(await split('今日本語', {今: '今', 今日: '今日', 本語: '本語'})).toBe('今日/本語');
});

test('はコーヒー does not fold into a false match', async () => {
    const forms = {は: 'は', はコー: '跛行', コーヒー: 'コーヒー'};
    expect(await split('はコーヒー', forms)).toBe('は/コーヒー');
});

test('a false match written in hiragana is refused too', async () => {
    const forms = {は: 'は', はコー: 'はこう', コーヒー: 'コーヒー'};
    expect(await split('はコーヒー', forms)).toBe('は/コーヒー');
});

test('katakana followed by hiragana is refused the same way', async () => {
    expect(await split('ケーキを', {ケーキ: 'ケーキ', ケーキを: 'けーきを', を: 'を'})).toBe('ケーキ/を');
});

test('a word really written with both kana stays whole', async () => {
    expect(await split('消しゴムを', {消: '消', 消しゴム: '消しゴム', を: 'を'})).toBe('消しゴム/を');
    expect(await split('ヤバい', {ヤバ: 'ヤバ', ヤバい: 'ヤバい'})).toBe('ヤバい');
});

test('an inflected word crossing the boundary stays whole if its headword does', async () => {
    expect(await split('サボった', {サボった: 'サボる'})).toBe('サボった');
    expect(await split('ヤバかった', {ヤバかった: 'ヤバい'})).toBe('ヤバかった');
});

test('the prolonged sound mark is no boundary', () => {
    expect(lastKanaBoundary('ラーメン')).toBe(-1);
    expect(lastKanaBoundary('おーい')).toBe(-1);
    expect(respectsKanaBoundary('ラーメン', 'らあめん')).toBe(true);
});

test('kanji are no boundary', () => {
    expect(lastKanaBoundary('食べる')).toBe(-1);
    expect(lastKanaBoundary('アメリカ人')).toBe(-1);
});

test('the boundary found is the last one', () => {
    expect(lastKanaBoundary('はコ')).toBe(1);
    expect(lastKanaBoundary('コはコ')).toBe(2);
});

test('a refused match is not a candidate, and a shorter one survives it', () => {
    const entry = (originalText, term) => ({headwords: [{term, reading: term, sources: [{originalText}]}]});
    expect([...candidatesFrom([entry('はコー', '跛行'), entry('は', 'は')]).keys()]).toEqual([1]);
    expect(candidatesFrom([]).size).toBe(0);
});

test('punctuation and line breaks end a run', () => {
    expect(splitRuns('はい、そう\nです！')).toEqual([
        {text: 'はい', start: 0}, {text: 'そう', start: 3}, {text: 'です', start: 6},
    ]);
});

test('iteration marks and the prolonged sound mark are letters', () => {
    expect(splitRuns('時々ラーメン')).toEqual([{text: '時々ラーメン', start: 0}]);
});

test('a match never crosses a line break', async () => {
    const words = await segmentText('行き\nます', fakeScan({行きます: '行く', 行き: '行き', ます: 'ます'}));
    expect(words.map(({text}) => text)).toEqual(['行き', 'ます']);
});

test('offsets index the original text, line breaks and all', async () => {
    const text = '「はい」\nそう';
    const words = await segmentText(text, fakeScan({はい: 'はい', そう: 'そう'}));
    expect(words.map(({text: word, start, end, known}) => [word, start, end, known])).toEqual([
        ['「', 0, 1, false], ['はい', 1, 3, true], ['」', 3, 4, false], ['そう', 5, 7, true],
    ]);
    for (const {text: word, start, end} of words) {
        expect(text.slice(start, end)).toBe(word);
    }
});

test('unknown text gathers into one piece', async () => {
    const words = await segmentText('はXYZは', fakeScan({は: 'は'}));
    expect(words.map(({text, known}) => [text, known])).toEqual([['は', true], ['XYZ', false], ['は', true]]);
});

test('a character outside the BMP is never cut in half', async () => {
    const words = await segmentText('𠮟は', fakeScan({は: 'は'}));
    expect(words.map(({text}) => text)).toEqual(['𠮟', 'は']);
});

test('text with nothing to look up gives punctuation only', async () => {
    const words = await segmentText('……！', fakeScan({}));
    expect(words).toEqual([{text: '……！', start: 0, end: 3, known: false}]);
    expect(await segmentText('', fakeScan({}))).toEqual([]);
});

test('a name loses to two ordinary words, and a name with hiragana loses to almost anything', async () => {
    const entry = (surface, term, dictionary, score = 0) => ({
        score,
        definitions: [{dictionary}],
        headwords: [{term, reading: term, sources: [{originalText: surface}]}],
    });
    const scan = async (window) => [
        entry('のこ', 'のこ', 'JMnedict [2026-10-31]'),
        entry('の', 'の', 'JMdict', 999_800),
        entry('こと', 'こと', 'JMdict', 999_800),
        entry('と', 'と', 'JMdict', 999_800),
    ].filter(({headwords: [{sources: [{originalText}]}]}) => window.startsWith(originalText));
    expect((await segmentText('のこと', scan)).map(({text}) => text)).toEqual(['の', 'こと']);
});

test('a rare form loses to the common words it splits into', async () => {
    const entry = (surface, score) => ({score, headwords: [{term: surface, reading: surface, sources: [{originalText: surface}]}]});
    const scan = async (window) => [entry('は', 1e6), entry('とても', 1e6), entry('はと', -300), entry('ても', 1e6)]
        .filter(({headwords: [{sources: [{originalText}]}]}) => window.startsWith(originalText));
    expect((await segmentText('はとても', scan)).map(({text}) => text)).toEqual(['は', 'とても']);
});

test('digits stay together', async () => {
    const words = await segmentText('2024年', fakeScan({年: '年', 20: '20', 2: '2'}));
    expect(words.map(({text}) => text)).toEqual(['2024', '年']);
});

test('katakana the dictionary lacks stays together', async () => {
    const words = await segmentText('ジョルジュは', fakeScan({ジョ: 'ジョ', は: 'は'}));
    expect(words.map(({text}) => text)).toEqual(['ジョルジュ', 'は']);
});

test('a known word carries its dictionary form', async () => {
    const [word] = await segmentText('行った', fakeScan({行った: '行く'}));
    expect(word).toMatchObject({term: '行く', known: true});
});
