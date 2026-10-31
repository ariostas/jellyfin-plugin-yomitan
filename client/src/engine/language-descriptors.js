// Stands in for Yomitan's language-descriptors.js in the bundle, keeping only the Japanese entry, so the other
// languages' transforms stay out of it. The entry is copied from that file, so a Yomitan bump has to check it.
// The version bump test in tests/e2e/engine.spec.mjs compares it against the original.
import {normalizeRadicalCharacters} from '../../../third_party/yomitan/ext/js/language/CJK-util.js';
import {
    alphabeticToHiragana,
    alphanumericWidthVariants,
    collapseEmphaticSequences,
    convertHalfWidthCharacters,
    convertHiraganaToKatakana,
    normalizeCJKCompatibilityCharacters,
    normalizeCombiningCharacters,
    standardizeKanji,
} from '../../../third_party/yomitan/ext/js/language/ja/japanese-text-preprocessors.js';
import {japaneseTransforms} from '../../../third_party/yomitan/ext/js/language/ja/japanese-transforms.js';
import {isStringPartiallyJapanese} from '../../../third_party/yomitan/ext/js/language/ja/japanese.js';

export const languageDescriptorMap = new Map([['ja', {
    iso: 'ja',
    iso639_3: 'jpn',
    name: 'Japanese',
    exampleText: '読め',
    isTextLookupWorthy: isStringPartiallyJapanese,
    textPreprocessors: {
        convertHalfWidthCharacters,
        alphabeticToHiragana,
        normalizeCombiningCharacters,
        normalizeCJKCompatibilityCharacters,
        normalizeRadicalCharacters,
        alphanumericWidthVariants,
        convertHiraganaToKatakana,
        collapseEmphaticSequences,
        standardizeKanji,
    },
    languageTransforms: japaneseTransforms,
}]]);
