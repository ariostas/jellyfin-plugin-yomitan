// Scores the splitter against the hand-labelled lines in corpus/labels.json. Usage, from the repository root:
//
//   node scripts/segmentation/score.mjs [--set dev|test|all] [--dicts jmdict|jitendex] [--errors 10|all] [--json file]
//                                       [--fresh] [--labels corpus/labels.json] [--server url] [--workers 4]
//
// It runs client/src/segmenter.js and the engine from source, in Node, against the dictionaries on a server from
// scripts/segmentation/server.sh, so an edit to the splitter needs no build. Labels are described in
// docs/segmentation-standard.md. Only dev's errors are ever listed: the test set is for checking a finished change.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {gunzipSync, gzipSync} from 'node:zlib';

const root = new URL('../../', import.meta.url).pathname;
const {values: options} = parseArgs({options: {
    labels: {type: 'string', default: 'corpus/labels.json'},
    set: {type: 'string', default: 'dev'},
    dicts: {type: 'string', default: 'jmdict'},
    errors: {type: 'string', default: '10'},
    json: {type: 'string'},
    server: {type: 'string', default: `http://127.0.0.1:${process.env.JF_PORT ?? '18790'}`},
    workers: {type: 'string', default: '4'},
    fresh: {type: 'boolean', default: false},
}});

const labelsPath = resolve(options.labels);
if (!existsSync(labelsPath)) {
    console.log(`Skipping: no ${relative(process.cwd(), labelsPath)}. The corpus is not in the repository; see CONTRIBUTING.md.`);
    process.exit(0);
}

if (!['dev', 'test', 'all'].includes(options.set) || !['jmdict', 'jitendex'].includes(options.dicts)) {
    console.error('--set is dev, test or all, and --dicts is jmdict or jitendex');
    process.exit(2);
}

// ---- Labels ----------------------------------------------------------------------------------------------------

/** What is compared: everything but white space, punctuation and symbols, on both sides. */
const NOT_LETTER = /[\s\p{P}\p{S}]/gu;
const lettersOf = (text) => text.replace(NOT_LETTER, '');

/** Lists every split a label allows. Each `(a|b)` is a choice, as in the fixture's patterns. */
function expand(split) {
    const match = /\(([^()]*)\)/.exec(split);
    if (!match) {
        return [split];
    }

    const [before, after] = [split.slice(0, match.index), split.slice(match.index + match[0].length)];
    return match[1].split('|').flatMap((choice) => expand(before + choice + after));
}

// `?` marks text that is not a word, left out of scoring. `@` marks a name and `*` slang or dialect, for sorting errors.
const MARKS = /^[?@*]+/;

/**
 * @returns {{letters: string, words: {text: string, start: number, end: number, skip: boolean, name: boolean, dialect: boolean}[]}}
 */
function parseSplit(split) {
    let start = 0;
    const words = split.split('/').filter(Boolean).map((raw) => {
        const marks = MARKS.exec(raw)?.[0] ?? '';
        const text = raw.slice(marks.length);
        const word = {
            text,
            start,
            end: start + text.length,
            skip: marks.includes('?'),
            name: marks.includes('@'),
            dialect: marks.includes('*'),
        };
        start = word.end;
        return word;
    });
    return {letters: words.map(({text}) => text).join(''), words};
}

function alternativesOf(label) {
    return [label.words, ...(label.or ?? [])].flatMap(expand).map(parseSplit);
}

const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
const problems = [];
for (const label of labels) {
    for (const {letters} of alternativesOf(label)) {
        if (letters !== lettersOf(label.text)) {
            problems.push(`${label.id ?? label.text}: ${letters} does not rebuild ${lettersOf(label.text)}`);
        }
    }

    if (!['dev', 'test'].includes(label.set)) {
        problems.push(`${label.id ?? label.text}: set is ${label.set}`);
    }
}

if (problems.length > 0) {
    console.error(`Labels that need fixing:\n  ${problems.join('\n  ')}`);
    process.exit(1);
}

const samplePath = join(dirname(labelsPath), 'sample.json');
if (existsSync(samplePath)) {
    const byId = new Map(labels.map((label) => [label.id, label]));
    const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
    const missing = sample.filter(({id}) => !byId.has(id)).length;
    const stale = sample.filter(({id, text}) => byId.has(id) && byId.get(id).text !== text).map(({id}) => id);
    if (missing > 0 || stale.length > 0) {
        console.log(`Of ${sample.length} lines in sample.json, ${missing} have no label${stale.length ? `, and these changed since labelled: ${stale.join(', ')}` : ''}.\n`);
    }
}

const chosen = labels.filter(({set}) => options.set === 'all' || set === options.set);

// ---- The engine, in Node -----------------------------------------------------------------------------------------

const yomitan = join(root, 'third_party/yomitan/');
const clientDirectory = join(root, 'client');
const {build} = await import(join(clientDirectory, 'node_modules/esbuild/lib/main.js'));
const buildDirectory = join(dirname(labelsPath), '.build');
mkdirSync(buildDirectory, {recursive: true});
const entry = join(buildDirectory, 'entry.js');
writeFileSync(entry, [
    `export {Engine} from '${clientDirectory}/src/engine/engine.js';`,
    `export {Segmenter, scanWindow, splitRuns} from '${clientDirectory}/src/segmenter.js';`,
].join('\n'));

// What client/build.mjs does to Yomitan's generated libraries and its languages, so this runs what the plugin ships.
const generated = {'kanji-processor.js': "export * from 'kanji-processor';", 'hangul-js.js': "export * as Hangul from 'hangul-js';"};
const plugins = [{
    name: 'yomitan-libs',
    setup(context) {
        context.onResolve({filter: /\/lib\/[\w-]+\.js$/}, ({path, importer}) => {
            const name = path.slice(path.lastIndexOf('/') + 1);
            return importer.startsWith(yomitan) && generated[name] ? {path: name, namespace: 'yomitan-lib'} : undefined;
        });
        context.onLoad({filter: /.*/, namespace: 'yomitan-lib'}, ({path}) => ({
            contents: generated[path],
            resolveDir: clientDirectory,
            loader: 'js',
        }));
    },
}, {
    name: 'japanese-only',
    setup(context) {
        context.onResolve({filter: /\/language-descriptors\.js$/}, ({importer}) => (
            importer === join(yomitan, 'ext/js/language/languages.js') ?
                {path: join(clientDirectory, 'src/engine/language-descriptors.js')} :
                undefined
        ));
    },
}];
const bundle = join(buildDirectory, 'engine.mjs');
await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'warning',
    plugins,
});
const {Engine, Segmenter, scanWindow, splitRuns} = await import(`${bundle}?${Date.now()}`);

const git = (...args) => {
    try {
        return execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'}).trim();
    } catch {
        return null;
    }
};

const auth = 'MediaBrowser Client="yomitan-segmentation", Device="segmentation", DeviceId="yomitan-segmentation-score", Version="1"';

/** @returns {Promise<{token: string, installed: object[]}|null>} The server's dictionaries, or null with no server. */
async function connect() {
    try {
        const response = await fetch(`${options.server}/Users/AuthenticateByName`, {
            method: 'POST',
            headers: {Authorization: auth, 'Content-Type': 'application/json'},
            body: JSON.stringify({Username: 'spike', Pw: 'spike'}),
        });
        if (!response.ok) {
            return null;
        }

        const {AccessToken: token} = await response.json();
        const list = await fetch(`${options.server}/Yomitan/Dictionaries`, {headers: {Authorization: `${auth}, Token="${token}"`}});
        return {token, installed: (await list.json()).dictionaries.map(({summary}) => summary)};
    } catch {
        return null;
    }
}

const connection = await connect();

// What the Translator finds in a window depends on the dictionaries, the engine and Yomitan, but not on the splitter. So
// it is kept between runs, and a run that only changes segmenter.js needs neither the Translator nor the server.
// Glossaries and the descriptions of inflection rules are most of the bulk and are not kept, so reading one from a kept
// entry throws, rather than finding nothing. --fresh ignores what was kept.
const engineDirectory = join(clientDirectory, 'src/engine');
const engineKey = createHash('sha256')
    .update(readdirSync(engineDirectory).sort().map((file) => readFileSync(join(engineDirectory, file), 'utf8')).join('\0'))
    .update(git('-C', yomitan, 'rev-parse', 'HEAD') ?? '')
    .digest('hex')
    .slice(0, 16);
const cachePath = join(dirname(labelsPath), '.cache', `${options.dicts}.json.gz`);
let cache = existsSync(cachePath) && !options.fresh ? JSON.parse(gunzipSync(readFileSync(cachePath)).toString('utf8')) : null;
if (cache?.engineKey !== engineKey) {
    cache = null;
}

const NOT_KEPT = {get() {
    throw new Error('Glossaries and rule descriptions are not kept between runs. Run with --fresh to read them.');
}};

/** @returns {object[]} The entries as kept on disk, without what is not kept. */
function slim(entries) {
    return entries.map((entry) => ({
        ...entry,
        inflectionRuleChainCandidates: entry.inflectionRuleChainCandidates.map((chain) => ({
            ...chain,
            inflectionRules: chain.inflectionRules.map(({name}) => ({name})),
        })),
        definitions: entry.definitions.map(({entries: _, ...definition}) => definition),
    }));
}

/** Makes what was not kept throw when read, so a splitter that starts to need it says so. */
function guard(entries) {
    for (const entry of entries) {
        for (const definition of entry.definitions) {
            Object.defineProperty(definition, 'entries', NOT_KEPT);
        }

        for (const rule of entry.inflectionRuleChainCandidates.flatMap(({inflectionRules}) => inflectionRules)) {
            Object.defineProperty(rule, 'description', NOT_KEPT);
        }
    }

    return entries;
}

const pattern = options.dicts === 'jmdict' ? /^JMdict\b/ : /^Jitendex/;
let dictionaries;
if (connection) {
    const find = (test) => connection.installed.find(({title}) => test.test(title));
    const chosenDictionaries = [find(pattern), find(/^JMnedict\b/), find(/^KANJIDIC\b/)];
    if (chosenDictionaries.includes(undefined)) {
        const titles = connection.installed.map(({title}) => title).join(', ') || 'none';
        console.error(`The server needs ${options.dicts === 'jmdict' ? 'JMdict' : 'Jitendex'}, JMnedict and KANJIDIC, and has: ${titles}`);
        process.exit(1);
    }

    dictionaries = chosenDictionaries.map(({title, revision, importDate}) => ({title, revision, importDate}));
    if (cache && JSON.stringify(cache.dictionaries) !== JSON.stringify(dictionaries)) {
        cache = null;
    }
} else if (cache) {
    ({dictionaries} = cache);
    console.log(`No server at ${options.server}, so this uses what was kept from the last run, which is enough unless a line or window is new.`);
} else {
    console.error(`No server at ${options.server}. Start one with scripts/segmentation/server.sh up.`);
    process.exit(1);
}

const order = dictionaries.map(({title}) => title);
const settings = {
    get: (name) => ({
        dictionaryOrder: order,
        disabledDictionaries: (connection?.installed ?? []).map(({title}) => title).filter((title) => !order.includes(title)),
    })[name],
    addEventListener() {},
};
const apiClient = {getUrl: (path) => `${options.server}/${path}`, accessToken: () => connection?.token};

const windows = new Map(Object.entries(cache?.windows ?? {}).map(([window, entries]) => [window, guard(entries)]));
let misses = 0;
let incomplete = false;

/** The engine as the Segmenter sees it, answering from what was kept, and from a real Engine for anything new. */
class CachedEngine {
    generation = 0;

    async _live() {
        if (!connection) {
            throw new Error(`A line needs the server at ${options.server}: start it with scripts/segmentation/server.sh up`);
        }

        this._engine ??= (async () => {
            const engine = new Engine({settings});
            await engine.open(apiClient);
            return engine;
        })();
        return this._engine;
    }

    async prefetch(list, prefetchOptions) {
        const missing = list.filter((window) => !windows.has(window));
        if (missing.length === 0) {
            return {complete: true};
        }

        const result = await (await this._live()).prefetch(missing, prefetchOptions);
        incomplete ||= !result.complete;
        return result;
    }

    async scan(window) {
        if (!windows.has(window)) {
            misses += 1;
            const entries = await (await this._live()).scan(window);
            windows.set(window, options.fresh ? entries : guard(slim(entries)));
        }

        return windows.get(window);
    }
}

const started = performance.now();
const segmenters = Array.from({length: Math.max(1, Number(options.workers))}, () => new Segmenter(new CachedEngine()));
const results = new Array(chosen.length);
await Promise.all(segmenters.map(async (segmenter, worker) => {
    for (let index = worker; index < chosen.length; index += segmenters.length) {
        results[index] = await segmenter.segment(chosen[index].text);
    }
}));
const seconds = (performance.now() - started) / 1000;

if (misses > 0 && !incomplete && !options.fresh) {
    mkdirSync(dirname(cachePath), {recursive: true});
    writeFileSync(cachePath, gzipSync(JSON.stringify({engineKey, dictionaries, windows: Object.fromEntries(windows)})));
}

// ---- Scoring -------------------------------------------------------------------------------------------------------

const NAME_DICTIONARY = /nedict|\bnames?\b/i;

/** The Translator's entry behind a word the splitter chose, found from the window it scanned. */
function entryOf(text, word) {
    const run = splitRuns(text).find(({start, text: runText}) => word.start >= start && word.start < start + runText.length);
    const entries = run ? windows.get(scanWindow(run.text, word.start - run.start)) ?? [] : [];
    return entries.find(({headwords}) => headwords.some(({term, sources}) => (
        term === word.term && sources.some(({originalText}) => originalText === word.text)
    )));
}

/** The splitter's words, reduced to letters as the labels are. */
function actualOf(text, words) {
    let start = 0;
    return words.flatMap((word) => {
        const letters = lettersOf(word.text);
        if (!letters) {
            return [];
        }

        const found = word.known ? entryOf(text, word) : undefined;
        const piece = {
            text: letters,
            start,
            end: start + letters.length,
            known: word.known,
            name: NAME_DICTIONARY.test(found?.definitions?.[0]?.dictionary ?? ''),
            inflected: found?.inflectionRuleChainCandidates?.some(({inflectionRules}) => inflectionRules.length > 0) ?? false,
        };
        start = piece.end;
        return [piece];
    });
}

const boundariesOf = (words) => new Set(words.slice(1).map(({start}) => start));
const inside = ({start, end}) => Array.from({length: end - start - 1}, (_, index) => start + index + 1);
const ignoredOf = (words) => new Set(words.filter(({skip}) => skip).flatMap(inside));

function compareWith(expected, actual) {
    const ignored = ignoredOf(expected.words);
    const wanted = [...boundariesOf(expected.words)].filter((at) => !ignored.has(at));
    const got = [...boundariesOf(actual)].filter((at) => !ignored.has(at));
    const gotSet = new Set(got);
    const hits = wanted.filter((at) => gotSet.has(at)).length;
    return {expected, hits, wanted: wanted.length, got: got.length, right: hits === wanted.length && hits === got.length, ignored};
}

const PARTICLES = new Set(('は が を に で と も の へ や か よ ね な わ ぞ ぜ さ し ば から まで より って けど けれど でも には とは では '
    + 'にも とも など なんて とか だけ しか ばかり くらい ぐらい ほど こそ さえ ので のに かな よね のよ かね わよ').split(' '));
const AUXILIARIES = new Set(('ます です でした だ だった た て ない たい ちゃう てる ん んだ んです じゃ じゃない だろう でしょう でしょ '
    + 'だろ っす じゃん られる れる せる させる よう う').split(' '));
const kanaScript = (character) => (/[ぁ-ゖ]/.test(character) ? 'hiragana' : (/[ァ-ヺ]/.test(character) ? 'katakana' : null));
const NOT_HIRAGANA = /[^ぁ-ゖ]/;

/** Sorts a wrong stretch into a rough kind, the first that fits, to show where to look. */
function kindOf(letters, expectedWords, actualWords, disputed) {
    if (expectedWords.some(({name}) => name) || actualWords.some(({name}) => name)) {
        return 'name';
    }

    if (expectedWords.some(({dialect}) => dialect)) {
        return 'slang or dialect';
    }

    const switchesKana = (at) => kanaScript(letters[at - 1]) && kanaScript(letters[at]) && kanaScript(letters[at - 1]) !== kanaScript(letters[at]);
    if (disputed.some(switchesKana)) {
        return 'kana boundary';
    }

    const pieces = [...expectedWords, ...actualWords];
    if (actualWords.some(({inflected}) => inflected) || pieces.some(({text}) => AUXILIARIES.has(text))) {
        return 'conjugation or auxiliary';
    }

    if (pieces.some(({text}) => PARTICLES.has(text))) {
        return 'particle';
    }

    if (disputed.every((at) => NOT_HIRAGANA.test(letters[at - 1]) && NOT_HIRAGANA.test(letters[at]))) {
        return 'compound';
    }

    return 'other';
}

/** The stretches between boundaries both sides agree on, where the two differ. */
function wrongStretches(letters, {expected, ignored}, actual) {
    const wanted = new Set([...boundariesOf(expected.words)].filter((at) => !ignored.has(at)));
    const got = new Set([...boundariesOf(actual)].filter((at) => !ignored.has(at)));
    const common = [0, ...[...wanted].filter((at) => got.has(at)), letters.length].sort((a, b) => a - b);
    const stretches = [];
    for (let index = 0; index < common.length - 1; index += 1) {
        const [from, to] = [common[index], common[index + 1]];
        const disputed = [...wanted, ...got].filter((at) => at > from && at < to && !(wanted.has(at) && got.has(at)));
        if (disputed.length === 0) {
            continue;
        }

        const within = ({start, end}) => start < to && end > from;
        const expectedWords = expected.words.filter(within);
        const actualWords = actual.filter(within);
        stretches.push({
            expected: expectedWords.map(({text, skip}) => (skip ? `?${text}` : text)).join('/'),
            actual: actualWords.map(({text}) => text).join('/'),
            kind: kindOf(letters, expectedWords, actualWords, disputed),
        });
    }

    return stretches;
}

const scored = chosen.map((label, index) => {
    const words = results[index];
    const actual = actualOf(label.text, words);
    const letters = lettersOf(label.text);
    const got = actual.map(({text}) => text).join('');
    // The alternative closest to what the splitter did is the one it is held to, so `or` never costs anything.
    const comparisons = alternativesOf(label).map((expected) => compareWith(expected, actual));
    const best = comparisons.reduce((a, b) => {
        const errors = (c) => (c.wanted - c.hits) + (c.got - c.hits);
        return errors(b) < errors(a) ? b : a;
    });
    return {
        ...label,
        actual: actual.map(({text}) => text).join('/'),
        expected: best.expected.words.map(({text, skip}) => (skip ? `?${text}` : text)).join('/'),
        right: got === letters && comparisons.some(({right}) => right),
        hits: best.hits,
        wanted: best.wanted,
        got: best.got,
        stretches: got === letters ? wrongStretches(letters, best, actual) : [{expected: letters, actual: got, kind: 'other'}],
    };
});

function summarize(lines) {
    const sum = (key) => lines.reduce((total, line) => total + line[key], 0);
    const [hits, wanted, got] = [sum('hits'), sum('wanted'), sum('got')];
    const precision = got ? hits / got : 1;
    const recall = wanted ? hits / wanted : 1;
    return {
        lines: lines.length,
        exact: lines.filter(({right}) => right).length,
        precision,
        recall,
        f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
    };
}

const groupBy = (items, key) => Map.groupBy(items, (item) => item[key]);
const sets = [...groupBy(scored, 'set')].sort(([a], [b]) => a.localeCompare(b)).map(([set, lines]) => ({
    set,
    ...summarize(lines),
    titles: [...groupBy(lines, 'title')].map(([title, titleLines]) => ({title, ...summarize(titleLines)})),
}));

const devErrors = scored.filter(({set, right}) => set === 'dev' && !right)
    .flatMap((line) => line.stretches.map((stretch) => ({...stretch, id: line.id, title: line.title, text: line.text, line: line.expected, got: line.actual})));
const kinds = [...groupBy(devErrors, 'kind')].sort((a, b) => b[1].length - a[1].length);

// ---- Report --------------------------------------------------------------------------------------------------------

const segmenterHash = createHash('sha256').update(readFileSync(join(clientDirectory, 'src/segmenter.js'))).digest('hex').slice(0, 12);
const provenance = {
    dictionaries,
    commit: git('rev-parse', '--short', 'HEAD'),
    dirty: Boolean(git('status', '--porcelain', '--', 'client/src')),
    yomitan: git('-C', yomitan, 'describe', '--tags', '--always'),
    segmenter: segmenterHash,
    seconds,
    cached: {windows: windows.size, new: misses},
};

const percent = (value) => `${(value * 100).toFixed(1)}%`;
const row = ({lines, exact, precision, recall, f1}) => `${String(exact).padStart(4)}/${String(lines).padEnd(4)} ${percent(exact / lines).padStart(6)}   `
    + `P ${percent(precision).padStart(6)}  R ${percent(recall).padStart(6)}  F1 ${percent(f1).padStart(6)}`;

console.log(`Dictionaries: ${dictionaries.map(({title, revision}) => `${title} (${revision})`).join(', ')}`);
console.log(`Code: ${provenance.commit}${provenance.dirty ? ' with changes to client/src' : ''}, segmenter.js ${segmenterHash}, Yomitan ${provenance.yomitan}`);
console.log(`${scored.length} lines in ${seconds.toFixed(1)} s, ${misses} of ${windows.size} windows looked up, the rest kept from earlier runs\n`);
console.log('Exact lines, then word boundaries');
for (const set of sets) {
    console.log(`${set.set.padEnd(28)} ${row(set)}`);
    for (const title of set.titles) {
        console.log(`  ${title.title.padEnd(26)} ${row(title)}`);
    }
}

if (devErrors.length > 0) {
    const limit = options.errors === 'all' ? Infinity : Number(options.errors);
    console.log(`\nWrong stretches on dev, by kind: ${kinds.map(([kind, items]) => `${kind} ${items.length}`).join(', ')}`);
    for (const [kind, items] of kinds) {
        console.log(`\n${kind} (${items.length})`);
        for (const item of items.slice(0, limit)) {
            console.log(`  ${item.id ?? item.title}  ${item.text}\n    expected ${item.expected}   got ${item.actual}\n    line     ${item.line}\n    got      ${item.got}`);
        }
    }
}

if (options.json) {
    writeFileSync(options.json, `${JSON.stringify({options, provenance, sets, kinds: Object.fromEntries(kinds.map(([kind, items]) => [kind, items.length])), devErrors}, null, 1)}\n`);
}
