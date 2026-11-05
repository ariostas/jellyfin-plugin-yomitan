// Segments the hand-checked corpus through the real engine, with real JMdict and JMnedict. Those are not in the
// repository, so this needs YOMITAN_REAL_DICTS, as parity-real.spec.mjs does.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from '@playwright/test';
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {credentials} from '../lib/jellyfin.mjs';
import {openEngine} from '../lib/engine-page.mjs';
import {corpus, heldOut, heldOutRoundTwo} from '../fixtures/segmentation-corpus.mjs';

const directory = process.env.YOMITAN_REAL_DICTS;
test.skip(!directory, 'Needs YOMITAN_REAL_DICTS');
test.describe.configure({timeout: 600_000});

test.beforeAll(async () => {
    test.setTimeout(600_000);
    const admin = await clientFor(credentials.username, credentials.password);
    const installed = (await (await admin.list()).json()).dictionaries.map(({title}) => title);
    if (installed.length === 3 && !process.env.YOMITAN_REIMPORT) {
        return;
    }

    await deleteAll(admin);
    for (const file of ['JMdict_english.zip', 'JMnedict.zip', 'KANJIDIC_english.zip']) {
        expect((await importArchive(admin, readFileSync(join(directory, file)))).state).toBe('succeeded');
    }
});

const isWord = ({text}) => !/^[\s\p{P}\p{S}]+$/u.test(text);

async function segmentAll(page, lines) {
    await openEngine(page);
    return page.evaluate(async (texts) => {
        const output = [];
        for (const text of texts) {
            output.push({text, words: await window.segmenter.segment(text)});
        }

        return output;
    }, lines.map(({text}) => text));
}

/** Lists every split a pattern allows. Each `(a|b)` is a choice. */
function expandPattern(pattern) {
    const match = /\(([^()]*)\)/.exec(pattern);
    if (!match) {
        return [pattern];
    }

    return match[1].split('|').flatMap((choice) => expandPattern(
        pattern.slice(0, match.index) + choice + pattern.slice(match.index + match[0].length),
    ));
}

function splitsOf({words, or = [], pattern}) {
    return pattern ? expandPattern(pattern) : [words, ...or];
}

function compare(lines, results) {
    return results.map(({text, words}, index) => {
        const {known} = lines[index];
        const allowed = splitsOf(lines[index]);
        // Labels leave punctuation out, and a word drawn out with ～ has some inside it.
        const got = words.filter(isWord).map((word) => word.text.replace(/[\s\p{P}\p{S}]/gu, '')).join('/');
        return {text, got, expected: allowed[0], known, right: allowed.includes(got)};
    });
}

test('the corpus has at least 40 lines, and every expected split rebuilds its line', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(40);
    for (const line of [...corpus, ...heldOut, ...heldOutRoundTwo]) {
        const letters = line.text.replace(/[\s\p{P}\p{S}]/gu, '');
        for (const split of splitsOf(line)) {
            expect(split.replaceAll('/', '')).toBe(letters);
        }
    }
});

for (const [name, lines] of [['corpus', corpus], ['first held-out lines', heldOut], ['second held-out lines', heldOutRoundTwo]]) {
    test(`the ${name} segment as a person would, or are documented known issues`, async ({page}) => {
        const checked = compare(lines, await segmentAll(page, lines));
        console.log(`${name}: ${checked.filter(({right}) => right).length} of ${checked.length} right`);
        for (const {text, got, expected, known, right} of checked) {
            if (!right) {
                console.log(`  ${known ? 'known' : 'WRONG'}: ${text}\n    got      ${got}\n    expected ${expected}${known ? `\n    ${known}` : ''}`);
            }
        }

        expect(checked.filter(({right, known}) => !right && !known).map(({text}) => text)).toEqual([]);
        expect(checked.filter(({right, known}) => right && known).map(({text}) => text)).toEqual([]);
    });
}
