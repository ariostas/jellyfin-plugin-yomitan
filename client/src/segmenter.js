// Splits Japanese text into words, choosing among everything the dictionaries match at every position.
//
// Plain greedy longest match, which the spike used, fails on real text: with a names dictionary loaded, 君のことなんて
// comes out 君/のこ/となん/て, because のこ and となん are somebody's name. So every candidate gets a cost, and the
// cheapest path through the line wins. A word costs about 1, so fewer words is better, and weak evidence costs more:
// a name, a rare word, or hiragana that only matches the reading of a word normally written in kanji.
//
// Two rules are absolute. Words stay inside a run of letters, so punctuation and line breaks are always boundaries.
// And a match may not cross a hiragana/katakana boundary unless a headword is written that way: Yomitan folds katakana
// to hiragana when matching, so in はコーヒー it finds はこう (跛行) and leaves ヒー. Words like ヤバい and 消しゴム
// really do mix the two, and their headwords show it.

/** Scanning this far ahead covers every headword worth finding. Yomitan's default is 16. */
export const SCAN_LENGTH = 20;

// ー and the iteration marks count as neither, so ラーメン is one script throughout.
const HIRAGANA = /[ぁ-ゖゝゞ]/;
const KATAKANA = /[ァ-ヺヽヾｦ-ﾝ]/;
const BREAK = /[\s\p{P}\p{S}]/u;
// These look like punctuation to Unicode but sit inside words: 〜 in names of durations, ＝ almost never, so only 〜.
const WORD_MARKS = /[々〆ヶヵゝゞ〜ー]/u;

function kanaScript(character) {
    if (HIRAGANA.test(character)) {
        return 'hiragana';
    }

    return KATAKANA.test(character) ? 'katakana' : null;
}

/** @returns {number} Index of the last character that starts a new kana script, or -1 if there is none. */
export function lastKanaBoundary(text) {
    let boundary = -1;
    let previous = null;
    for (let index = 0; index < text.length; index += 1) {
        const script = kanaScript(text[index]);
        if (script && previous && script !== previous) {
            boundary = index;
        }

        previous = script;
    }

    return boundary;
}

/**
 * Tells a word really written with both kana from a match that only exists because of folding.
 * @param {string} surface The text as written.
 * @param {string} term The headword it matched, in dictionary form, so it can differ after the last boundary.
 * @returns {boolean} True if the match does not cross a boundary, or the headword crosses the same one.
 */
export function respectsKanaBoundary(surface, term) {
    const boundary = lastKanaBoundary(surface);
    for (let index = 0; index <= boundary; index += 1) {
        if (kanaScript(surface[index]) !== kanaScript(term[index] ?? '')) {
            return false;
        }
    }

    return true;
}

function isBreak(character) {
    return BREAK.test(character) && !WORD_MARKS.test(character);
}

/**
 * @param {string} text
 * @returns {{text: string, start: number}[]} The runs of letters in `text`, which are what can hold words.
 */
export function splitRuns(text) {
    const runs = [];
    let start = -1;
    Array.from(text).reduce((index, character) => {
        if (isBreak(character)) {
            if (start >= 0) {
                runs.push({text: text.slice(start, index), start});
                start = -1;
            }
        } else if (start < 0) {
            start = index;
        }

        return index + character.length;
    }, 0);

    if (start >= 0) {
        runs.push({text: text.slice(start), start});
    }

    return runs;
}

/**
 * @param {string} run
 * @param {number} index
 * @returns {string} What to scan from `index`.
 */
export function scanWindow(run, index) {
    return run.slice(index, index + SCAN_LENGTH);
}

const COST = {
    // Kana words like また are filed under a kanji headword, so a priority word's reading is only slightly suspect.
    priority: {term: 1, reading: 1.05},
    common: {term: 1, reading: 1.3},
    uncommon: {term: 1.5, reading: 2.2},
    rare: {term: 2, reading: 2.7},
    name: 1.5,
    // Names in hiragana or part hiragana are nearly all coincidences, like のこ or 夢の.
    nameWithHiragana: 6,
    // Each character past the third of a rare phrase. また会う日まで is a title, and four plain words here.
    rarePhraseCharacter: 0.6,
    // A span that splits around a particle is those words, not one: 気がいい is 気 + が + いい.
    phrase: 2,
    // A kanji word plus a particle, like 今日は, is that word and that particle, though the dictionary has "hello".
    particleTail: 1.2,
    // A form the deinflector explains, with a matching part of speech, is good evidence of a word. Not for two kana,
    // though: でよ is an imperative of 出る only by accident.
    inflected: 0.85,
    // Short hiragana that only inflects a kanji verb by its reading is usually something else: くるんだ is くる + んだ
    // far more often than 包んだ, and のもう after a noun is の + もう.
    weakInflection: 1.1,
    kanji: -0.1,
    // Kanji the headword does not have came from a suffix rule, as when な気 reads as ない + 気.
    foreignKanji: 0.6,
    unknownCharacter: 3,
    number: 1,
    // A little more than two words, so デジタルカメラ splits if both parts are known, but ダシャラタ stays whole.
    unknownKatakana: 2.1,
};

/** JMdict's scores: priority words are in the hundreds of thousands, and rare forms sit far below zero. */
const PRIORITY_SCORE = 500_000;
const RARE_SCORE = -10_000;
const NAME_DICTIONARY = /nedict|\bnames?\b/i;
const HAS_HIRAGANA = /[\u3041-\u3096]/;
const HAS_KANJI = /\p{Script=Han}/u;
const WEAK_INFLECTION_LENGTH = 4;
// つ counts on its own, as in １つ, where other counters are words the dictionary has.
const NUMBER = /^[0-9０-９]+つ?/;
const KATAKANA_RUN = /^[\u30A1-\u30FA\u30FCｦ-ﾝ]+/;
const KATAKANA_WORD = /^[\u30A1-\u30FA\u30FC]+$/;
// A kanji word plus one of these is that word and that particle. か and に are left out: 確か and 特に are words.
const KANJI_WORD_TAIL = /[はがをでとものへねよ]/;
// Inside a span these suggest several words. か, の and よ are too often just part of one, as in 確かに.
const INNER_PARTICLE = /[はがをにでと]/;
// These never sit inside a word on their own, while に and の do, as in 気に入る and 日の出.
const CASE_PARTICLE = /[はがを]/;
// After kana these still end a word, where も and で are as likely to be part of it, as in それでも.
const SENTENCE_ENDING = /[ねよ]/;
const CASE_ENDING = /[がを]/;

function commonness(score) {
    if (score >= PRIORITY_SCORE) {
        return 'priority';
    }

    if (score >= 0) {
        return 'common';
    }

    return score > RARE_SCORE ? 'uncommon' : 'rare';
}

/** @returns {boolean} True if hiragana matched a katakana headword, or the reverse, which only folding allows. */
function isFolded(surface, term) {
    const first = kanaScript(surface[0]);
    const other = kanaScript(term[0]);
    return first !== null && other !== null && first !== other;
}

/** @returns {number} The cost of a word if this entry is the best explanation of it. */
function entryCost({score = 0, definitions, inflectionRuleChainCandidates}, surface, {term, reading = term}, {matchSource = 'term'}) {
    if (NAME_DICTIONARY.test(definitions?.[0]?.dictionary ?? '')) {
        return HAS_HIRAGANA.test(surface) ? COST.nameWithHiragana : COST.name;
    }

    const level = commonness(score);
    // A reading in katakana is how the word is written. JMdict files コーヒー under 珈琲, which hardly anyone uses, with
    // the kanji's low score, so as a reading it would lose to the same katakana with no entry at all.
    const spelled = matchSource === 'term' ? term : reading;
    const written = (matchSource === 'term' || KATAKANA_WORD.test(reading)) && !isFolded(surface, spelled);
    let cost = COST[level][written ? 'term' : 'reading'];
    if ((level === 'uncommon' || level === 'rare') && HAS_KANJI.test(surface) && HAS_HIRAGANA.test(surface)) {
        cost += COST.rarePhraseCharacter * Math.max(0, surface.length - 3);
    }

    const inflected = inflectionRuleChainCandidates?.some(({inflectionRules}) => inflectionRules.length > 0);
    if (inflected && (surface.length > 2 || HAS_KANJI.test(surface))) {
        cost *= COST.inflected;
    }

    if (inflected && !written && !HAS_KANJI.test(surface) && surface.length <= WEAK_INFLECTION_LENGTH) {
        cost += COST.weakInflection;
    }

    const kanji = surface.match(/\p{Script=Han}/gu) ?? [];
    if (kanji.length === 0) {
        return cost;
    }

    return cost + COST.kanji + (kanji.every((character) => term.includes(character)) ? 0 : COST.foreignKanji);
}

/**
 * Reduces a Translator result to the best candidate of each length.
 * @param {object[]} dictionaryEntries Entries from `findTerms`, with their sources.
 * @returns {Map<number, {cost: number, term: string, reading: string, priority: boolean}>} By length in UTF-16 units.
 */
export function candidatesFrom(dictionaryEntries) {
    const candidates = new Map();
    for (const entry of dictionaryEntries) {
        for (const {term, reading, sources} of entry.headwords) {
            for (const source of sources) {
                const {originalText} = source;
                if (!respectsKanaBoundary(originalText, term)) {
                    continue;
                }

                const cost = entryCost(entry, originalText, {term, reading}, source);
                const best = candidates.get(originalText.length);
                if (!best || cost < best.cost) {
                    candidates.set(originalText.length, {cost, term, reading, priority: (entry.score ?? 0) >= PRIORITY_SCORE});
                }
            }
        }
    }

    return candidates;
}

function hasParticleTail(prefix, last) {
    if (HAS_KANJI.test(prefix)) {
        return KANJI_WORD_TAIL.test(last);
    }

    return SENTENCE_ENDING.test(last) || (prefix.length >= 2 && CASE_ENDING.test(last));
}

/** @returns {boolean} True if run[start, end) is really a word, a particle and possibly another word. */
function splitsAroundParticle(run, start, end, allCandidates, priority) {
    for (let index = start; index < end - 1; index += 1) {
        const particle = priority ? CASE_PARTICLE : INNER_PARTICLE;
        const before = index === start || allCandidates[start].has(index - start);
        if (particle.test(run[index]) && before && allCandidates[index + 1]?.has(end - index - 1)) {
            return index > start || !priority;
        }
    }

    return false;
}

/** The cheapest split of one run of letters, by dynamic programming from its end. */
async function splitRun(run, scan) {
    const {length} = run;
    const allCandidates = new Array(length);
    const best = new Array(length + 1).fill(null);
    best[length] = {cost: 0, words: 0, next: null};

    const consider = (start, end, cost, word) => {
        const rest = best[end];
        if (!rest) {
            return;
        }

        const total = cost + rest.cost;
        const words = rest.words + 1;
        const current = best[start];
        // On a tie, fewer words, and then the longer first word.
        const better = !current || total < current.cost - 1e-9
            || (Math.abs(total - current.cost) <= 1e-9 && (words < current.words || (words === current.words && end > current.end)));
        if (better) {
            best[start] = {cost: total, words, end, word};
        }
    };

    for (let start = length - 1; start >= 0; start -= 1) {
        const code = run.charCodeAt(start);
        if (code >= 0xDC00 && code <= 0xDFFF && start > 0) {
            continue;
        }

        const window = scanWindow(run, start);
        const candidates = candidatesFrom(await scan(window));
        allCandidates[start] = candidates;
        for (const [matchLength, {cost, term, reading, priority}] of candidates) {
            const end = start + matchLength;
            const prefix = run.slice(start, end - 1);
            const tail = hasParticleTail(prefix, run[end - 1]) && candidates.has(matchLength - 1);
            const phrase = splitsAroundParticle(run, start, end, allCandidates, priority);
            consider(start, end, cost + (tail ? COST.particleTail : 0) + (phrase ? COST.phrase : 0), {term, reading});
        }

        const rest = run.slice(start);
        const number = NUMBER.exec(rest);
        if (number) {
            consider(start, start + number[0].length, COST.number, null);
        }

        const katakana = KATAKANA_RUN.exec(rest);
        if (katakana) {
            consider(start, start + katakana[0].length, COST.unknownKatakana, null);
        }

        consider(start, start + String.fromCodePoint(run.codePointAt(start)).length, COST.unknownCharacter, null);
    }

    const pieces = [];
    for (let position = 0; position < length;) {
        const {end, word} = best[position];
        pieces.push({start: position, end, word});
        position = end;
    }

    return pieces;
}

/**
 * @typedef {object} Word
 * @property {string} text The text as written.
 * @property {number} start Offset into the cue's text, in UTF-16 units.
 * @property {number} end Offset of the end, exclusive.
 * @property {boolean} known Whether the dictionary has it. Punctuation and unknown text are in the list too, so the
 *   words cover the whole text except white space.
 * @property {string} [term] Dictionary form, for a known word.
 * @property {string} [reading] Reading of `term`.
 */

/**
 * Segments one piece of text.
 * @param {string} text Text, possibly of several lines.
 * @param {(window: string) => Promise<object[]>} scan Returns the Translator's entries for a window of text.
 * @returns {Promise<Word[]>}
 */
export async function segmentText(text, scan) {
    const words = [];
    const addUnknown = (start, end) => {
        const previous = words.at(-1);
        if (previous && !previous.known && previous.end === start) {
            previous.text += text.slice(start, end);
            previous.end = end;
        } else {
            words.push({text: text.slice(start, end), start, end, known: false});
        }
    };

    // Between runs is punctuation, which is kept as words, and white space, which is not.
    const addGap = (start, end) => {
        for (const {0: piece, index} of text.slice(start, end).matchAll(/\S+/gu)) {
            addUnknown(start + index, start + index + piece.length);
        }
    };

    let position = 0;
    for (const run of splitRuns(text)) {
        addGap(position, run.start);
        for (const {start, end, word} of await splitRun(run.text, scan)) {
            const from = run.start + start;
            const to = run.start + end;
            if (word) {
                words.push({text: text.slice(from, to), start: from, end: to, known: true, ...word});
            } else {
                addUnknown(from, to);
            }
        }

        position = run.start + run.text.length;
    }

    addGap(position, text.length);
    return words;
}

export class Segmenter {
    /**
     * @param {import('./engine/engine.js').Engine} engine
     * @param {object} [options]
     * @param {AbortSignal} [options.signal] Ends whatever segmenting is under way, as when the session ends.
     */
    constructor(engine, {signal} = {}) {
        this._engine = engine;
        this._signal = signal;
        this._results = new Map();
    }

    /**
     * The result for a text already segmented, for rendering without a pause.
     * @param {string} text
     * @returns {Word[]|undefined}
     */
    peek(text) {
        return this._results.get(text);
    }

    /**
     * Segments text. A text segmented before costs no requests, and a new one costs one for all its candidates, plus
     * a second only if a dictionary redirects a form to another headword.
     * @param {string} text
     * @returns {Promise<Word[]>}
     */
    async segment(text) {
        const cached = this._results.get(text);
        if (cached) {
            return cached;
        }

        const generation = this._engine.generation;
        const windows = splitRuns(text).flatMap((run) => (
            Array.from({length: run.text.length}, (_, index) => scanWindow(run.text, index))
        ));
        const {complete} = await this._engine.prefetch(windows, {signal: this._signal});
        const words = await segmentText(text, (window) => this._engine.scan(window));

        // A cut-short answer can miss the longest match, so it is used now and not kept.
        if (complete && generation === this._engine.generation) {
            this._results.set(text, words);
        }

        return words;
    }

    /** Forgets every result, as when a dictionary changed. */
    clear() {
        this._results.clear();
    }
}
