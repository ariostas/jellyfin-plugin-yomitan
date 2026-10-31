// Decides whether a subtitle track is Japanese. Anything else stays exactly as Jellyfin renders it.

const JAPANESE_TAGS = new Set(['ja', 'jp', 'jpn', 'jap', 'japanese']);
// Tags that say nothing about the language, so the content has to decide.
const UNDETERMINED_TAGS = new Set(['', 'und', 'unk', 'unknown', 'mis', 'mul', 'zxx', 'xxx', 'none']);

// Share of all letters that are Japanese. Low enough to accept a line with a Latin name in it, or a two-language
// track, and high enough to refuse English with a few Japanese words.
const MIN_JAPANESE_SHARE = 0.3;
// Share of Japanese letters that are kana. Japanese prose rarely drops below half, and Chinese has none.
const MIN_KANA_SHARE = 0.15;
// Fewer letters than this say nothing.
const MIN_JAPANESE_LETTERS = 10;

/**
 * Measures a track's text.
 * @param {string[]} texts
 * @returns {{letters: number, kana: number, kanji: number}}
 */
export function countLetters(texts) {
    const counts = {letters: 0, kana: 0, kanji: 0};
    for (const text of texts) {
        for (const [character] of text.matchAll(/\p{L}/gu)) {
            counts.letters += 1;
            if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)) {
                counts.kana += 1;
            } else if (/\p{Script=Han}/u.test(character)) {
                counts.kanji += 1;
            }
        }
    }

    return counts;
}

function looksJapanese(texts) {
    const {letters, kana, kanji} = countLetters(texts);
    const japanese = kana + kanji;
    return japanese >= MIN_JAPANESE_LETTERS
        && japanese / letters >= MIN_JAPANESE_SHARE
        && kana / japanese >= MIN_KANA_SHARE;
}

/**
 * The one place that decides whether the plugin takes over a track. Phase 6 can add a setting here.
 * @param {{Language?: string|null}} stream A subtitle stream from `playbackManager.subtitleTracks()`.
 * @param {{text: string}[]} cues The track's cues.
 * @returns {boolean} True for a track tagged Japanese, and for an untagged one whose text is.
 */
export function isJapaneseTrack(stream, cues) {
    const [tag] = (stream.Language ?? '').trim().toLowerCase().split(/[-_]/);
    if (JAPANESE_TAGS.has(tag)) {
        return true;
    }

    return UNDETERMINED_TAGS.has(tag) && looksJapanese(cues.map(({text}) => text));
}
