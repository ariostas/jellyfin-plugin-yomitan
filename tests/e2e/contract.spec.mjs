// Keeps docs/api.md honest: replays its examples in order against the real server, and compares its tables
// with the source. With YOMITAN_UPDATE_API_DOC=1 it writes the responses into the document instead.
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from '@playwright/test';
import {clientFor, deleteAll, waitForJob} from '../lib/dictionaries.mjs';
import {credentials} from '../lib/jellyfin.mjs';
import {makeDictionary} from '../lib/zip.mjs';

const root = new URL('../../', import.meta.url).pathname;
const documentPath = join(root, 'docs/api.md');
const source = join(root, 'src/Jellyfin.Plugin.Yomitan');
const update = process.env.YOMITAN_UPDATE_API_DOC === '1';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64');

const exampleZip = () => makeDictionary({title: 'Example', format: 3, revision: '2026.01', sequenced: true, frequencyMode: 'rank-based'}, {
    'term_bank_1.json': [
        ['食べる', 'たべる', 'v1', 'v1', 100, [
            'to eat',
            {type: 'image', path: 'pic.png', title: 'A picture'},
            {type: 'structured-content', content: {tag: 'div', content: ['to live on']}},
        ], 1, 'P'],
        ['かな', '', '', '', 0, ['kana'], 2, ''],
    ],
    'term_meta_bank_1.json': [
        ['食べる', 'freq', 500],
        ['食べる', 'pitch', {reading: 'たべる', pitches: [{position: 2}]}],
    ],
    'kanji_bank_1.json': [['食', 'ショク', 'た.べる', 'jouyou', ['eat', 'food'], {strokes: '9'}]],
    'kanji_meta_bank_1.json': [['食', 'freq', 300]],
    'tag_bank_1.json': [['v1', 'partOfSpeech', 0, 'ichidan verb', 0], ['P', 'popular', -10, 'common word', 10]],
    'pic.png': png,
    'styles.css': '.example { color: teal; }',
});

const archives = {'<example.zip>': exampleZip};

const pattern = /(<!-- example(?: job=(\d+))? -->\n```http request\n)([\s\S]*?)\n```\n\n```http response\n([\s\S]*?)\n```/g;

function parseMessage(text) {
    const [head, ...rest] = text.split('\n\n');
    const [start, ...headerLines] = head.split('\n');
    const headers = Object.fromEntries(headerLines.map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon), line.slice(colon + 1).trim()];
    }));
    return {start, headers, body: rest.join('\n\n')};
}

// Values that differ between runs. Only their kind has to match.
const volatile = new Set(['id', 'importDate', 'createdAt', 'startedAt', 'finishedAt', 'sizeBytes', 'databaseBytes', 'freeBytes', 'bytesProcessed']);

// A job's first response races with the worker.
const racy = new Set(['state', 'phase', 'title', 'progress']);

function kindOf(value) {
    return value === null ? 'null' : typeof value;
}

function compare(actual, expected, path, loose) {
    if (Array.isArray(expected) || (typeof expected === 'object' && expected !== null)) {
        expect(kindOf(actual), path).toBe(kindOf(expected));
        expect(Object.keys(actual), path).toEqual(Object.keys(expected));
        for (const key of Object.keys(expected)) {
            const next = `${path}.${key}`;
            if (volatile.has(key) || (loose && racy.has(key))) {
                expect(['null', kindOf(expected[key])], next).toContain(kindOf(actual[key]));
            } else {
                compare(actual[key], expected[key], next, loose);
            }
        }

        return;
    }

    expect(actual, path).toBe(expected);
}

const statusText = {200: 'OK', 202: 'Accepted', 400: 'Bad Request', 404: 'Not Found'};

test('every example in docs/api.md does what it says', async () => {
    test.setTimeout(60_000);
    const client = await clientFor(credentials.username, credentials.password);
    await deleteAll(client);

    const document = readFileSync(documentPath, 'utf8');
    const examples = [...document.matchAll(pattern)];
    expect(examples.length).toBeGreaterThan(9);
    expect(document.match(/<!-- example/g).length).toBe(examples.length);

    const jobs = [];
    let updated = document;
    for (const example of examples) {
        const [whole, opening, jobIndex, requestText, responseText] = example;
        const request = parseMessage(requestText);
        const expected = parseMessage(responseText);
        let [method, path] = request.start.split(' ');
        const label = request.start;

        if (jobIndex !== undefined) {
            await waitForJob(client, jobs[jobIndex]);
            path = path.replace('{id}', jobs[jobIndex]);
        }

        const body = archives[request.body]?.() ?? (request.body || undefined);
        const response = await client.send(path, {method, body, headers: request.headers});

        const isJson = response.headers.get('content-type')?.startsWith('application/json');
        const text = isJson ? await response.text() : null;
        const value = text ? JSON.parse(text) : null;
        if (response.status === 202) {
            jobs.push(value.id);
            await waitForJob(client, value.id); // So the next example sees a settled server.
        }

        if (update) {
            const head = [`HTTP/1.1 ${response.status} ${statusText[response.status]}`];
            for (const name of Object.keys(expected.headers)) {
                head.push(`${name}: ${response.headers.get(name)}`);
            }

            const written = value === null ? head.join('\n') : `${head.join('\n')}\n\n${JSON.stringify(value, null, 2)}`;
            updated = updated.replace(whole, `${opening}${requestText}\n\`\`\`\n\n\`\`\`http response\n${written}\n\`\`\``);
            continue;
        }

        expect(`${response.status}`, label).toBe(expected.start.split(' ')[1]);
        for (const [name, content] of Object.entries(expected.headers)) {
            expect(response.headers.get(name), `${label}: ${name}`).toBe(content);
        }

        expect(value === null, `${label}: has a body`).toBe(expected.body === '');
        if (value !== null) {
            compare(value, JSON.parse(expected.body), label, response.status === 202);
        }
    }

    if (update) {
        writeFileSync(documentPath, updated);
    }

    await deleteAll(client);
});

test.describe('the tables in docs/api.md', () => {
    const document = readFileSync(documentPath, 'utf8');
    const read = (file) => readFileSync(join(source, file), 'utf8');
    const allSource = readdirSync(join(source, 'Dictionaries'))
        .map((file) => read(`Dictionaries/${file}`))
        .concat(read('Api/DictionaryController.cs'))
        .join('\n');

    test('list the real query limits', () => {
        const queryLimits = read('Dictionaries/DictionaryQuery.cs');
        for (const [, name, expression] of queryLimits.matchAll(/public const int (Max\w+) = ([^;]+);/g)) {
            // eslint-disable-next-line no-eval
            const value = eval(expression.replaceAll('_', ''));
            expect(document, name).toContain(`| \`${name}\` | ${value}`);
        }
    });

    test('list the real import defaults', () => {
        const limits = read('Dictionaries/ImportLimits.cs');
        const units = {MiB: 1024 ** 2, GiB: 1024 ** 3};
        const found = [...limits.matchAll(/public \w+ (Max\w+) \{ get; init; \} = ([^;]+);/g)];
        expect(found.length).toBe(6);
        for (const [, name, expression] of found) {
            const value = Function('MiB', 'GiB', `return ${expression.replaceAll('_', '')}`)(units.MiB, units.GiB);
            expect(document, name).toContain(`| \`${name}\` | ${value} |`);
        }
    });

    test('list the real queue sizes', () => {
        const jobs = read('Dictionaries/JobQueue.cs');
        expect(document).toContain(`At most ${/MaxPending = (\d+)/.exec(jobs)[1]} jobs can be pending`);
        expect(document).toContain(`most recent ${/MaxFinished = (\d+)/.exec(jobs)[1]} finished jobs`);
    });

    test('list exactly the error codes the code can produce', () => {
        const section = document.slice(document.indexOf('## Error codes'), document.indexOf('## Where this differs'));
        const documented = [...section.matchAll(/^\| `(\w+)` \|/gm)].map(([, code]) => code).sort();
        const patterns = [
            /new (?:ImportException|QueryException)\(\s*"(\w+)"/g,
            /Exception\(\s*\$?"(\w+)"/g,
            /errorCode: "(\w+)"/g,
            /Error\(StatusCodes\.\w+, "(\w+)"/g,
            /Fail\(job, "(\w+)"/g,
            /new\("(\w+)", \$/g,
            /"limit_exceeded"/g,
            /ParseJson\(\w+, [^,]+, "(\w+)"\)/g,
        ];
        const used = new Set(patterns.flatMap((regex) => [...allSource.matchAll(regex)].map(([match, code]) => code ?? match.replaceAll('"', ''))));
        expect(documented).toEqual([...used].sort());
    });

    test('name every route the controller has', () => {
        const controller = read('Api/DictionaryController.cs');
        const routes = [...controller.matchAll(/\[Http(Get|Post|Delete)\("([^"]+)"\)\]/g)]
            .map(([, method, path]) => `${method.toUpperCase()} /Yomitan/${path.replace('{id:guid}', '{id}')}`);
        expect(routes.length).toBe(6);
        for (const route of routes) {
            expect(document, route).toContain(`### \`${route}\``);
        }

        expect([...document.matchAll(/^### `(\w+ \/Yomitan\/\S+)`$/gm)].map(([, route]) => route).sort()).toEqual([...routes].sort());
    });

    test('name every operation, and each runs in the batch example', () => {
        const query = read('Dictionaries/DictionaryQuery.cs');
        const operations = [...new Set([...query.matchAll(/case "((?:find|get)\w+)"/g)].map(([, op]) => op))];
        expect(operations.length).toBe(8);
        for (const op of operations) {
            expect(document, op).toContain(`| \`${op}\` |`);
            expect(document, op).toContain(`{"op": "${op}"`);
        }
    });

    test('name every phase a job can report', () => {
        const importer = read('Dictionaries/DictionaryImporter.cs');
        const phases = new Set(['reading', ...[...importer.matchAll(/_phase = "(\w+)"/g)].map(([, phase]) => phase)]);
        for (const phase of phases) {
            expect(document, phase).toContain(`\`${phase}\``);
        }
    });
});
