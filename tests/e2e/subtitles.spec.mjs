// The subtitle modules, which have no DOM, so they run here in Node on real inputs.
import {readFileSync} from 'node:fs';
import {expect, test} from '@playwright/test';
import {parseAss} from '../../client/src/subtitles/ass.js';
import {buildCues, cleanText} from '../../client/src/subtitles/cleanup.js';
import {countLetters, isJapaneseTrack} from '../../client/src/subtitles/language.js';
import {trackContent} from '../../client/src/subtitles/source.js';
import {CueTimeline} from '../../client/src/subtitles/timeline.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const typesetCues = () => buildCues(parseAss(fixture('typeset.ass')));
const cueWith = (cues, text) => cues.filter((cue) => cue.text === text);

test.describe('text cleanup', () => {
    for (const [name, raw, expected] of [
        ['override tags', '{\\i1}昨日は{\\i0}学校に', '昨日は学校に'],
        ['a hard line break', '学校に\\N行きませんでした', '学校に\n行きませんでした'],
        ['a soft break, as a space', 'ひとつ\\nふたつ', 'ひとつ ふたつ'],
        ['a hard space', 'ひとつ\\hふたつ', 'ひとつ ふたつ'],
        ['a drawing', '{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}', ''],
        ['a drawing between text', '前{\\p2}m 0 0 l 1 1{\\p0}後', '前後'],
        ['a drawing that is never closed', '前{\\p1}m 0 0 l 1 1', '前'],
        ['\\pos, which is not \\p', '{\\pos(10,10)}見える', '見える'],
        ['\\pbo, which is not \\p', '{\\p1\\pbo5}m 0 0{\\p0}見える', '見える'],
        ['karaoke timing inside a word', '{\\k20}か{\\kf30}ん{\\ko25}じ{\\K10}語', 'かんじ語'],
        ['a comment in braces', '{TL note}台詞', '台詞'],
        ['SRT markup', '<i>斜体</i>の<font color="#ffffff">文字</font>', '斜体の文字'],
        ['a break tag', '一行目<br>二行目<br/>三行目', '一行目\n二行目\n三行目'],
        ['a comparison, which is not markup', 'a < b > c', 'a < b > c'],
        ['an override in an SRT', '{\\an8}上に出る', '上に出る'],
        ['empty lines', '\\N一行\\N\\N', '一行'],
        ['carriage returns', '一行目\r\n二行目', '一行目\n二行目'],
        ['vertical text, one character to a line', 'そ\\Nれ\\Nで\\Nも', 'それでも'],
        ['two short lines, which are not vertical text', 'は\\Nい', 'は\nい'],
    ]) {
        test(name, () => {
            expect(cleanText(raw)).toBe(expected);
        });
    }
});

test.describe('ASS parsing', () => {
    test('reads every field, and commas in the text survive', () => {
        const [event] = parseAss('[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
            + 'Dialogue: 3,1:02:03.45,1:02:04.00,Top,太郎,0,0,0,Banner;15,はい、そう, です');
        expect(event).toEqual({
            layer: 3, start: 3723.45, end: 3724, style: 'Top', name: '太郎', effect: 'Banner;15', text: 'はい、そう, です',
        });
    });

    test('follows the Format line, as in SSA', () => {
        const [event] = parseAss('[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
            + 'Dialogue: Marked=0,0:00:01.00,0:00:02.00,*Default,,0,0,0,,台詞');
        expect(event).toMatchObject({start: 1, end: 2, style: 'Default', text: '台詞'});
    });

    test('ignores comments, other sections, a BOM and broken lines', () => {
        const events = parseAss('﻿[Script Info]\nDialogue: not an event\n[Events]\n'
            + 'Format: Start, End, Text\nComment: 0:00:01.00,0:00:02.00,ない\n'
            + 'Dialogue: 0:00:01.00,0:00:02.00,ある\nDialogue: broken\n[Fonts]\nDialogue: 0:00:01.00,0:00:02.00,ない');
        expect(events.map(({text}) => text)).toEqual(['ある']);
    });
});

test.describe('dialogue and signs in a fansub-style script', () => {
    test('comments never appear', () => {
        expect(typesetCues().some(({text}) => text.includes('コメント'))).toBe(false);
    });

    test('tags and breaks are gone from a plain line', () => {
        const [cue] = cueWith(typesetCues(), '昨日は学校に\n行きませんでした');
        expect(cue).toMatchObject({kind: 'dialogue', start: 2, end: 4});
    });

    test('overlapping speakers are both dialogue, and both show', () => {
        const cues = typesetCues();
        const timeline = new CueTimeline(cues);
        expect(timeline.at(7).cues.map(({text, kind}) => [text, kind])).toEqual([
            ['彼女はケーキを 食べられなかった', 'dialogue'],
            ['えっ、本当に？', 'dialogue'],
        ]);
    });

    test('three outline layers of one line are one cue', () => {
        const copies = cueWith(typesetCues(), '重ねた行です');
        expect(copies.length).toBe(1);
        expect(copies[0]).toMatchObject({kind: 'dialogue', start: 10, end: 12});
    });

    test('a drawing is dropped, its label is a sign, and dialogue over it stays dialogue', () => {
        const cues = typesetCues();
        expect(cues.some(({text}) => /m 0 0/.test(text))).toBe(false);
        const shown = new CueTimeline(cues).at(14).cues.map(({text, kind}) => [text, kind]);
        expect(shown).toEqual([['駅前商店街', 'sign'], ['看板の前で話す', 'dialogue']]);
    });

    test('a sign repeated frame by frame is one cue', () => {
        const copies = cueWith(typesetCues(), '追跡する看板');
        expect(copies.length).toBe(1);
        expect(copies[0]).toMatchObject({kind: 'sign', start: 16, end: 18});
    });

    test('karaoke keeps the lyric whole, drops romaji, and drops generated syllables', () => {
        const cues = typesetCues();
        expect(cueWith(cues, 'そっと開いたドアの向こうに')[0]).toMatchObject({kind: 'sign'});
        expect(cues.some(({text}) => text.includes('sotto') || text.includes('so tto'))).toBe(false);
        expect(new CueTimeline(cues).at(24.2).cues).toEqual([]);
    });

    test('an episode title is a sign, with its line break', () => {
        expect(cueWith(typesetCues(), '第一話\n旅立ちの朝')[0]).toMatchObject({kind: 'sign'});
    });

    test('a comment in braces and a scroll effect leave dialogue alone', () => {
        const cues = typesetCues();
        expect(cueWith(cues, '朝の話だよね')[0]).toMatchObject({kind: 'dialogue'});
        expect(cueWith(cues, '流れる文字の行です')[0]).toMatchObject({kind: 'dialogue'});
    });

    test('styling inside a line does not split it', () => {
        expect(cueWith(typesetCues(), '緑の太字と別の書体')[0]).toMatchObject({kind: 'dialogue'});
    });

    test('positions on every line of a script are dialogue, as in TV captions', () => {
        const event = (start, text) => ({start, end: start + 1, style: 'Default', text: `{\\pos(960,1000)}${text}`});
        const cues = buildCues([event(1, 'はい'), event(2, 'いいえ'), event(3, 'そうです')]);
        expect(cues.map(({kind}) => kind)).toEqual(['dialogue', 'dialogue', 'dialogue']);
    });

    test('a position on one line among many is a sign', () => {
        const event = (start, text) => ({start, end: start + 1, style: 'Default', text});
        const cues = buildCues([event(1, 'はい'), event(2, 'いいえ'), event(3, 'そうです'), event(4, '{\\pos(1,1)}掲示板')]);
        expect(cues.at(-1)).toMatchObject({text: '掲示板', kind: 'sign'});
    });

    test('text from Stream.js, with no style information, is dialogue unless its tags say otherwise', () => {
        const cues = buildCues([
            {start: 1, end: 2, text: '普通の台詞'},
            {start: 1, end: 2, text: '{\\an8}上の台詞'},
            {start: 3, end: 4, text: '{\\pos(10,10)}標識'},
        ]);
        expect(cues.map(({text, kind}) => [text, kind])).toEqual([
            ['普通の台詞', 'dialogue'], ['上の台詞', 'dialogue'], ['標識', 'sign'],
        ]);
    });

    test('a line repeated later is two cues', () => {
        const cues = buildCues([{start: 1, end: 2, text: 'はい'}, {start: 5, end: 6, text: 'はい'}]);
        expect(cues.map(({start}) => start)).toEqual([1, 5]);
    });

    test('an empty or backwards event is dropped', () => {
        expect(buildCues([{start: 1, end: 2, text: '{\\i1}'}, {start: 3, end: 3, text: 'ある'}])).toEqual([]);
    });
});

test.describe('timeline', () => {
    const cues = [
        {id: 0, start: 1, end: 3, text: 'a', kind: 'dialogue'},
        {id: 1, start: 2, end: 4, text: 'b', kind: 'dialogue'},
        {id: 2, start: 6, end: 7, text: 'c', kind: 'dialogue'},
    ];
    const timeline = new CueTimeline(cues);

    for (const [time, key] of [[0.99, ''], [1, '0'], [2, '0,1'], [2.99, '0,1'], [3, '1'], [4, ''], [5, ''], [6.5, '2'], [7, ''], [100, '']]) {
        test(`at ${time} shows [${key}]`, () => {
            expect(timeline.at(time).key).toBe(key);
        });
    }

    test('upcoming cues are the next to start', () => {
        expect(timeline.upcoming(1.5, 2).map(({id}) => id)).toEqual([1, 2]);
        expect(timeline.upcoming(7, 2)).toEqual([]);
    });

    test('an empty track shows nothing', () => {
        expect(new CueTimeline([]).at(5).cues).toEqual([]);
    });
});

test.describe('which tracks are Japanese', () => {
    const japanese = [{text: '昨日は学校に行きませんでした'}, {text: '彼女はケーキを食べられなかった'}];
    const english = [{text: 'I did not go to school yesterday'}];
    const chinese = [{text: '昨天我没有去学校'}, {text: '她没能吃蛋糕但是她很高兴'}];

    for (const language of ['jpn', 'ja', 'JPN', 'ja-JP', 'jp', 'jap', 'japanese']) {
        test(`the tag ${language} is enough, whatever the text says`, () => {
            expect(isJapaneseTrack({Language: language}, english)).toBe(true);
        });
    }

    for (const language of ['eng', 'en', 'zho', 'chi', 'kor', 'fre']) {
        test(`the tag ${language} is enough to refuse Japanese text`, () => {
            expect(isJapaneseTrack({Language: language}, japanese)).toBe(false);
        });
    }

    for (const language of [null, undefined, '', 'und', 'unk', 'mis']) {
        test(`with the tag ${language}, the text decides`, () => {
            expect(isJapaneseTrack({Language: language}, japanese)).toBe(true);
            expect(isJapaneseTrack({Language: language}, english)).toBe(false);
            expect(isJapaneseTrack({Language: language}, chinese)).toBe(false);
        });
    }

    test('the fixtures for untagged tracks measure as expected', () => {
        const lines = (name) => fixture(name).split('\n').filter((line) => line && !/^\d+$|-->/.test(line)).map((text) => ({text}));
        expect(isJapaneseTrack({}, lines('untagged-japanese.srt'))).toBe(true);
        expect(isJapaneseTrack({}, lines('untagged-chinese.srt'))).toBe(false);
        expect(isJapaneseTrack({}, lines('sync.en.srt'))).toBe(false);
    });

    test('a few Japanese words in English are not a Japanese track', () => {
        expect(isJapaneseTrack({}, [{text: 'She said ありがとう and left, then the rest of this long line is plain English with no more'}])).toBe(false);
    });

    test('a track with almost no text decides nothing', () => {
        expect(isJapaneseTrack({}, [{text: 'はい'}])).toBe(false);
        expect(isJapaneseTrack({}, [])).toBe(false);
    });

    test('letters are counted by script', () => {
        expect(countLetters(['漢字とカナ abc 123 ！'])).toEqual({letters: 8, kana: 3, kanji: 2});
    });
});

test.describe('what a track holds', () => {
    test('text', () => {
        expect(trackContent({IsTextSubtitleStream: true, DeliveryMethod: 'External'})).toBe('text');
    });

    test('images', () => {
        expect(trackContent({IsTextSubtitleStream: false, Codec: 'PGSSUB', DeliveryMethod: 'Embed'})).toBe('image');
        expect(trackContent({IsTextSubtitleStream: false, Codec: 'dvdsub'})).toBe('image');
    });

    test('burned in, even for a text format', () => {
        expect(trackContent({IsTextSubtitleStream: true, DeliveryMethod: 'Encode'})).toBe('burned-in');
    });
});
