// Turns raw subtitle events into cues: plain text, sorted, without duplicates, each marked as dialogue or a sign.
//
// Dialogue goes in the main line. A sign is text placed on the picture, such as an episode title, and gets its own
// block. How an event is classified, in order:
//   1. Drawings, empty text and generated karaoke syllables are dropped.
//   2. A style named like a sign, title or song is a sign. So is an effect such as fx or karaoke.
//   3. Rotation, shear or clipping is a sign. Dialogue is never drawn that way.
//   4. \pos or \move outside the main style is a sign. Inside it, it counts only if under half of that style's
//      events are positioned: captions from Japanese TV position every line, and all of those are dialogue.
//   5. Everything else is dialogue.

const MAIN_STYLE_POSITIONED_SHARE = 0.5;
// Copies of a line closer together than this are one line: motion tracking repeats text frame by frame.
const MERGE_GAP_SECONDS = 0.05;
// Karaoke templates emit one event per mora, and typesetters sometimes place text a character at a time.
const FRAGMENT_LENGTH = 2;
const MIN_VERTICAL_LINES = 3;

const JAPANESE_LETTER = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
// `EDJP` and `OPRomaji` are songs. `Editor` and `Opinion` are not.
const SONG_STYLE = /^(?:OP|ED|Op|Ed)(?![a-z])|opening|ending/;
const SIGN_STYLE = /sign|title|typeset|caption|karaoke|kara\b|romaji|lyric|song|insert/i;
const SIGN_EFFECT = /^(?:fx|code|template|karaoke)\b/i;
const OVERRIDE_BLOCK = /\{([^}]*)\}/g;
const MARKUP_TAG = /<\/?(?:i|b|u|s|c|v|font|ruby|rt)(?:[\s.][^>]*)?>/gi;
const POSITIONED = /\\(?:pos|move)\s*\(/;
const DISTORTED = /\\(?:fr[xyz]?-?\d|fa[xy]-?\d|i?clip\s*\()/;

/** @returns {string} All override tags of a raw text, for looking at, with their braces. */
function overridesOf(text) {
    return [...text.matchAll(OVERRIDE_BLOCK)].map(([, tags]) => tags).join('');
}

/**
 * Reduces raw subtitle text to what is read. `\N` and `<br>` are line breaks, `\n` is a soft break and `\h` a hard
 * space, which libass both draws as a space unless the script's WrapStyle says otherwise. Everything in braces goes,
 * and so does what a `\p1` drawing mode covers.
 * @param {string} raw
 * @returns {string} Trimmed lines joined with `\n`, or an empty string.
 */
export function cleanText(raw) {
    let result = '';
    let drawing = false;
    let position = 0;
    for (const match of raw.matchAll(OVERRIDE_BLOCK)) {
        if (!drawing) {
            result += raw.slice(position, match.index);
        }

        for (const [, level] of match[1].matchAll(/\\p(\d+)(?![\d.])/g)) {
            drawing = Number(level) > 0;
        }

        position = match.index + match[0].length;
    }

    if (!drawing) {
        result += raw.slice(position);
    }

    const lines = result
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(MARKUP_TAG, '')
        .replace(/\\N/g, '\n')
        .replace(/\\[nh]/g, ' ')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    // Vertical text is typeset with a break after every character, and reads as one line.
    const vertical = lines.length >= MIN_VERTICAL_LINES && lines.every((line) => [...line].length === 1);
    return lines.join(vertical ? '' : '\n');
}

function heaviestStyle(events) {
    const weights = new Map();
    for (const {style, text} of events) {
        if (style !== undefined) {
            weights.set(style, (weights.get(style) ?? 0) + text.length);
        }
    }

    return [...weights].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** The style with the most text among unpositioned events, or among all of them if every event is positioned. */
function findMainStyle(events) {
    return heaviestStyle(events.filter(({tags}) => !POSITIONED.test(tags))) ?? heaviestStyle(events);
}

function mainStylePositionedShare(events, mainStyle) {
    const main = events.filter(({style}) => style === mainStyle);
    return main.length ? main.filter(({tags}) => POSITIONED.test(tags)).length / main.length : 0;
}

function classify({style = '', effect = '', tags}, mainStyle, mainIsPositioned) {
    if (style !== mainStyle && (SONG_STYLE.test(style) || SIGN_STYLE.test(style))) {
        return 'sign';
    }

    if (SIGN_EFFECT.test(effect) || DISTORTED.test(tags)) {
        return 'sign';
    }

    if (POSITIONED.test(tags) && (style !== mainStyle || !mainIsPositioned)) {
        return 'sign';
    }

    return 'dialogue';
}

/** A sign with no Japanese in it is a translator's note or romaji, and short overlapping ones are karaoke syllables. */
function dropUnusableSigns(cues) {
    const fragments = cues.filter(({kind, text}) => kind === 'sign' && [...text].length <= FRAGMENT_LENGTH);
    const overlaps = (a, b) => a !== b && a.start < b.end && b.start < a.end;
    return cues.filter((cue) => {
        if (cue.kind !== 'sign') {
            return true;
        }

        return JAPANESE_LETTER.test(cue.text) && !(fragments.includes(cue) && fragments.some((other) => overlaps(cue, other)));
    });
}

/** Merges copies of one text that overlap or touch: outline layers, and signs repeated frame by frame. */
function mergeCopies(cues) {
    const open = new Map();
    const merged = [];
    for (const cue of cues) {
        const earlier = open.get(cue.text);
        if (earlier && cue.start <= earlier.end + MERGE_GAP_SECONDS) {
            earlier.end = Math.max(earlier.end, cue.end);
            earlier.kind = earlier.kind === 'dialogue' ? 'dialogue' : cue.kind;
        } else {
            open.set(cue.text, cue);
            merged.push(cue);
        }
    }

    return merged;
}

/**
 * @param {{start: number, end: number, text: string, style?: string, effect?: string}[]} events Raw events. Times are
 *   seconds, and style and effect are absent for formats without them.
 * @returns {import('./timeline.js').Cue[]} Cues sorted by start, with `id` their index.
 */
export function buildCues(events) {
    const prepared = events
        .map((event) => ({...event, tags: overridesOf(event.text), text: cleanText(event.text)}))
        .filter(({text, start, end}) => text && end > start);

    const mainStyle = findMainStyle(prepared);
    const mainIsPositioned = mainStylePositionedShare(prepared, mainStyle) >= MAIN_STYLE_POSITIONED_SHARE;
    const cues = prepared
        .map(({start, end, text, ...rest}) => ({start, end, text, kind: classify(rest, mainStyle, mainIsPositioned)}))
        .sort((a, b) => a.start - b.start || a.end - b.end);

    return mergeCopies(dropUnusableSigns(cues)).map((cue, id) => ({...cue, id}));
}
