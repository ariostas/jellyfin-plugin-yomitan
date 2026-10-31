// A small dictionary for the playback tests, written here so it can be in the repository. Real dictionaries are for
// the specs that take YOMITAN_REAL_DICTS.
import {makeZip} from './zip.mjs';

const terms = [
    ['昨日', 'きのう', 'n'], ['学校', 'がっこう', 'n'], ['彼女', 'かのじょ', 'n'], ['ケーキ', 'ケーキ', 'n'],
    ['コーヒー', 'コーヒー', 'n'], ['友達', 'ともだち', 'n'], ['映画', 'えいが', 'n'], ['明日', 'あした', 'n'],
    ['雨', 'あめ', 'n'], ['猫', 'ねこ', 'n'], ['窓', 'まど', 'n'], ['外', 'そと', 'n'], ['お金', 'おかね', 'n'],
    ['駅', 'えき', 'n'], ['本', 'ほん', 'n'], ['先生', 'せんせい', 'n'], ['手紙', 'てがみ', 'n'], ['電車', 'でんしゃ', 'n'],
    ['山', 'やま', 'n'], ['子供', 'こども', 'n'], ['公園', 'こうえん', 'n'], ['靴', 'くつ', 'n'], ['日本語', 'にほんご', 'n'],
    ['音楽', 'おんがく', 'n'], ['海', 'うみ', 'n'], ['字幕', 'じまく', 'n'], ['台詞', 'せりふ', 'n'], ['最初', 'さいしょ', 'n'],
    ['駅前', 'えきまえ', 'n'], ['商店街', 'しょうてんがい', 'n'], ['看板', 'かんばん', 'n'], ['第一話', 'だいいちわ', 'n'],
    // What plain greedy matching finds in はコーヒー, once コー has folded to こう.
    ['跛行', 'はこう', 'n'],
    ['は', 'は', 'prt'], ['に', 'に', 'prt'], ['を', 'を', 'prt'], ['が', 'が', 'prt'], ['と', 'と', 'prt'], ['で', 'で', 'prt'],
    ['の', 'の', 'prt'], ['へ', 'へ', 'prt'], ['か', 'か', 'prt'], ['も', 'も', 'prt'], ['まで', 'まで', 'prt'], ['から', 'から', 'prt'],
    ['です', 'です', 'cop'], ['だろう', 'だろう', 'exp'], ['この', 'この', 'adj'], ['もう', 'もう', 'adv'], ['また', 'また', 'adv'],
    ['とても', 'とても', 'adv'], ['早い', 'はやい', 'adj-i', 'adj-i'], ['面白い', 'おもしろい', 'adj-i', 'adj-i'],
    ['新しい', 'あたらしい', 'adj-i', 'adj-i'], ['いい', 'いい', 'adj-i', 'adj-i'], ['ない', 'ない', 'adj-i', 'adj-i'],
    ['行く', 'いく', 'v5', 'v5'], ['飲む', 'のむ', 'v5', 'v5'], ['見る', 'みる', 'v1', 'v1'], ['食べる', 'たべる', 'v1', 'v1'],
    ['降る', 'ふる', 'v5', 'v5'], ['買う', 'かう', 'v5', 'v5'], ['歩く', 'あるく', 'v5', 'v5'], ['書く', 'かく', 'v5', 'v5'],
    ['遅れる', 'おくれる', 'v1', 'v1'], ['登る', 'のぼる', 'v5', 'v5'], ['遊ぶ', 'あそぶ', 'v5', 'v5'], ['寝る', 'ねる', 'v1', 'v1'],
    ['勉強', 'べんきょう', 'n'], ['する', 'する', 'vs', 'vs'], ['来る', 'くる', 'vk', 'vk'], ['言う', 'いう', 'v5', 'v5'],
    ['開ける', 'あける', 'v1', 'v1'], ['聞く', 'きく', 'v5', 'v5'], ['走る', 'はしる', 'v5', 'v5'], ['泳ぐ', 'およぐ', 'v5', 'v5'],
    ['会う', 'あう', 'v5', 'v5'], ['話す', 'はなす', 'v5', 'v5'], ['流れる', 'ながれる', 'v1', 'v1'], ['文字', 'もじ', 'n'],
    ['行', 'ぎょう', 'n'], ['朝', 'あさ', 'n'], ['話', 'はなし', 'n'], ['重ねる', 'かさねる', 'v1', 'v1'],
    ['本当', 'ほんとう', 'n'], ['長い', 'ながい', 'adj-i', 'adj-i'], ['一行', 'いちぎょう', 'n'], ['狭い', 'せまい', 'adj-i', 'adj-i'],
    ['画面', 'がめん', 'n'], ['折り返す', 'おりかえす', 'v5', 'v5'], ['はず', 'はず', 'n'], ['文章', 'ぶんしょう', 'n'], ['これ', 'これ', 'n'],
];

export const miniDictionaryTitle = 'Mini';

/**
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {string[][]} [options.extraTerms] More rows, in the form of `terms`.
 * @param {string|string[]} [options.longTerm] Terms to give enough senses that the popup has to scroll.
 * @returns {Buffer} A format 3 dictionary archive.
 */
export function makeMiniDictionary({title = miniDictionaryTitle, extraTerms = [], longTerm} = {}) {
    const senses = (term) => ([longTerm].flat().includes(term) ?
        Array.from({length: 80}, (_, index) => `sense ${index} of ${term}`) :
        [`meaning of ${term}`]);
    const rows = [...terms, ...extraTerms].map(([term, reading, partOfSpeech, rules = ''], index) => (
        [term, reading, partOfSpeech, rules, 0, senses(term), index + 1, '']
    ));
    const entry = (name, value) => ({name, data: Buffer.from(JSON.stringify(value))});
    return makeZip([
        entry('index.json', {title, format: 3, revision: '1', sequenced: true}),
        entry('term_bank_1.json', rows),
        entry('tag_bank_1.json', [['n', 'partOfSpeech', 0, 'noun', 0]]),
    ]);
}
