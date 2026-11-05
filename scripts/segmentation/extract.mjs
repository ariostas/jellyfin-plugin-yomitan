// Turns the subtitles under corpus/ into the lines to label: every usable line of dialogue per title, a sample of them
// spread over whole episodes, and a smaller sample for a second labeller. Usage, from the repository root:
//
//   node scripts/segmentation/extract.mjs [--corpus corpus]
//
// It reads corpus/titles.json, which says what each title is and where its files are (see CONTRIBUTING.md), and writes
//   corpus/lines/<id>.json   every line kept, with its file and time
//   corpus/sample.json       the lines to label, the same every run for the same seed
//   corpus/second-pass.txt   about 100 of those, text only, for measuring how well two labellers agree, and their ids
//                            in second-pass.ids.txt
//   corpus/SOURCES.md        the titles, where they came from and why they were chosen
//
// Subtitles are never committed, since they may be copyrighted. Archives are untrusted: each is unpacked into a new
// empty directory, after its listing is checked, and nothing in it is ever run.
import {execFileSync} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {basename, extname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {parseArgs} from 'node:util';
import {parseAss} from '../../client/src/subtitles/ass.js';
import {buildCues} from '../../client/src/subtitles/cleanup.js';

const {values: options} = parseArgs({options: {corpus: {type: 'string', default: 'corpus'}}});
const corpus = resolve(options.corpus);
const manifestPath = join(corpus, 'titles.json');
if (!existsSync(manifestPath)) {
    console.log(`No ${relative(process.cwd(), manifestPath)}, so there is nothing to extract. See CONTRIBUTING.md.`);
    process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const {seed = 1, perTitle = 50, secondPass = 100} = manifest;

const ARCHIVE = /\.(?:zip|rar|7z)$/i;
const SUBTITLE = /\.(?:srt|ass|ssa)$/i;
/** An archive that unpacks to more than this is not subtitles. */
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

/** Unpacks an archive into a new empty directory, and returns that directory. */
function unpack(archive, into) {
    const listing = execFileSync('7z', ['l', '-slt', '-ba', archive], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    let total = 0;
    for (const [, path] of listing.matchAll(/^Path = (.*)$/gm)) {
        const parts = path.split(/[\\/]/);
        if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || parts.includes('..')) {
            throw new Error(`${archive} has an entry outside its directory: ${path}`);
        }
    }

    for (const [, size] of listing.matchAll(/^Size = (\d+)$/gm)) {
        total += Number(size);
    }

    if (total > MAX_UNPACKED_BYTES) {
        throw new Error(`${archive} would unpack to ${total} bytes`);
    }

    rmSync(into, {recursive: true, force: true});
    mkdirSync(into, {recursive: true});
    // -snl is left off, so links are not made. Overwrites are refused, so two entries cannot fight over one path.
    execFileSync('7z', ['x', '-aos', '-bd', '-y', `-o${into}`, archive], {stdio: ['ignore', 'ignore', 'inherit']});

    // Belt and braces: whatever is there must be a plain file or directory, inside `into`.
    const root = realpathSync(into);
    const walk = (directory) => readdirSync(directory).flatMap((name) => {
        const path = join(directory, name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) {
            rmSync(path, {force: true});
            console.warn(`  Removed ${relative(corpus, path)}, which is not a plain file`);
            return [];
        }

        if (!realpathSync(path).startsWith(root + sep)) {
            throw new Error(`${path} is outside ${root}`);
        }

        return stat.isDirectory() ? walk(path) : [path];
    });
    return walk(into);
}

/** Subtitles come in UTF-8, UTF-16 or Shift JIS. */
function decode(bytes) {
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
        return new TextDecoder('utf-16le').decode(bytes);
    }

    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
        return new TextDecoder('utf-16be').decode(bytes);
    }

    try {
        return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch {
        return new TextDecoder('shift_jis').decode(bytes);
    }
}

function srtTime(text) {
    const match = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(text);
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`) : Number.NaN;
}

/** Jellyfin parses SRT on the server, so the client has no parser for it. This is the usual format, no more. */
function parseSrt(text) {
    const events = [];
    for (const block of text.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n{2,}/)) {
        const lines = block.split('\n');
        const timing = lines.findIndex((line) => line.includes('-->'));
        if (timing < 0) {
            continue;
        }

        const [start, end] = lines[timing].split('-->').map(srtTime);
        events.push({start, end, text: lines.slice(timing + 1).join('\\N')});
    }

    return events.filter(({start, end}) => Number.isFinite(start) && Number.isFinite(end));
}

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const LETTER = /[\p{L}\p{N}]/gu;
// Ruby written inline after its kanji, as Netflix captions do: 漢字(かんじ).
const INLINE_RUBY = /(?<=[\p{Script=Han}々ヶ])[(（][\p{Script=Hiragana}\p{Script=Katakana}ー・]+[)）]/gu;
// Speaker labels and sound notes: （花子）, （ドアの音）, [拍手], ［ナレーション］, 【字幕】.
const BRACKETED = /（[^）]*）|\([^)]*\)|\[[^\]]*\]|［[^］]*］|【[^】]*】|〈[^〉]*〉/gu;
const SONG = /[♪♫♬〽]/u;

/** @returns {string|null} The line as the splitter would see it, or null if it is no use for scoring. */
function cleanLine(text) {
    if (SONG.test(text)) {
        return null;
    }

    const cleaned = text
        .replace(INLINE_RUBY, '')
        .replace(BRACKETED, ' ')
        // A line break is a boundary to the splitter, just as a space is, and one line is easier to label.
        .replace(/\s+/gu, '　')
        .replace(/^　+|　+$/gu, '');
    const letters = cleaned.match(LETTER)?.length ?? 0;
    return JAPANESE.test(cleaned) && letters >= 2 ? cleaned : null;
}

/** @returns {{start: number, text: string}[]} The dialogue lines of one file, in order, as the plugin builds them. */
function linesOf(path) {
    const text = decode(readFileSync(path));
    const events = /\.srt$/i.test(path) ? parseSrt(text) : parseAss(text);
    return buildCues(events)
        .filter(({kind}) => kind === 'dialogue')
        .map(({start, text: cue}) => ({start, text: cleanLine(cue)}))
        .filter(({text: line}) => line);
}

/** A small seeded generator, so a sample is the same on every machine. */
function random(seedText) {
    let state = [...seedText].reduce((hash, character) => Math.imul(hash ^ character.codePointAt(0), 0x01000193), 0x811C9DC5);
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
    };
}

/** One line from each of `count` equal stretches, so the sample covers every episode rather than one scene. */
function spreadSample(lines, count, next) {
    if (lines.length <= count) {
        return [...lines];
    }

    return Array.from({length: count}, (_, index) => {
        const from = Math.floor(index * lines.length / count);
        const to = Math.floor((index + 1) * lines.length / count);
        return lines[from + Math.floor(next() * (to - from))];
    });
}

const naturalOrder = (a, b) => a.localeCompare(b, 'en', {numeric: true});

mkdirSync(join(corpus, 'lines'), {recursive: true});
const sample = [];
const counts = [];
for (const title of manifest.titles) {
    if (title.files.length === 0) {
        counts.push({title, files: 0, lines: 0, sampled: 0});
        console.log(`${title.id}: no files yet, skipped`);
        continue;
    }

    const files = [];
    for (const file of title.files) {
        const path = join(corpus, file);
        if (ARCHIVE.test(file)) {
            const unpacked = unpack(path, join(corpus, 'unpacked', title.id, basename(file, extname(file))));
            files.push(...unpacked.filter((name) => SUBTITLE.test(name)));
        } else {
            files.push(path);
        }
    }

    const match = title.match ? new RegExp(title.match, 'u') : null;
    const chosen = files.filter((path) => !match || match.test(relative(corpus, path))).sort(naturalOrder);
    const seen = new Set();
    const lines = chosen.flatMap((path) => linesOf(path).map(({start, text}) => ({file: relative(corpus, path), start, text})))
        .filter(({text}) => !seen.has(text) && seen.add(text));
    writeFileSync(join(corpus, 'lines', `${title.id}.json`), `${JSON.stringify(lines, null, 1)}\n`);

    const picked = spreadSample(lines, title.perTitle ?? perTitle, random(`${seed}:${title.id}`));
    picked.forEach(({file, start, text}, index) => sample.push({
        id: `${title.id}-${String(index + 1).padStart(2, '0')}`,
        title: title.id,
        set: title.set,
        file,
        time: Number(start.toFixed(2)),
        text,
    }));
    counts.push({title, files: chosen.length, lines: lines.length, sampled: picked.length});
    console.log(`${title.id} (${title.set}): ${chosen.length} files, ${lines.length} lines, ${picked.length} sampled`);
}

writeFileSync(join(corpus, 'sample.json'), `${JSON.stringify(sample, null, 1)}\n`);

// The second pass takes the same share of every title, so no one title decides the agreement. Its ids, line for line,
// are kept apart, so the second labeller sees only the text.
const next = random(`${seed}:second-pass`);
const second = [...Map.groupBy(sample, ({title}) => title).values()].flatMap((lines) => {
    const shuffled = lines.map((line) => ({line, key: next()})).sort((a, b) => a.key - b.key).map(({line}) => line);
    return shuffled.slice(0, Math.round(secondPass * lines.length / sample.length));
});
writeFileSync(join(corpus, 'second-pass.txt'), `${second.map(({text}) => text).join('\n')}\n`);
writeFileSync(join(corpus, 'second-pass.ids.txt'), `${second.map(({id}) => id).join('\n')}\n`);

const cell = (text) => String(text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
writeFileSync(join(corpus, 'SOURCES.md'), [
    '# Segmentation corpus sources',
    '',
    `Written by scripts/segmentation/extract.mjs from titles.json. Seed ${seed}, ${sample.length} lines sampled, `
        + `${second.length} in second-pass.txt. These files are not in the repository.`,
    '',
    '| Title | Kind | Set | Page | Files | Lines | Sampled | Why |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...counts.map(({title, files, lines, sampled}) => `| ${cell(title.title)} | ${cell(title.kind)} | ${title.set} | ${cell(title.page)} `
        + `| ${cell(title.files.join(', '))}${title.match ? ` (matching \`${cell(title.match)}\`, ${files} files)` : ''} | ${lines} `
        + `| ${sampled} | ${cell(title.reason)} |`),
    '',
].join('\n'));
console.log(`${sample.length} lines in sample.json, ${second.length} in second-pass.txt`);
