import {execFileSync} from 'node:child_process';
import http from 'node:http';
import {expect, test} from '@playwright/test';
import {clientFor, deleteAll, importArchive, inContainer, spooledUploads, waitForJob} from '../lib/dictionaries.mjs';
import {credentials, server} from '../lib/jellyfin.mjs';
import {makeDictionary, makeZip} from '../lib/zip.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64');
const scriptedSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(document.domain)</script></svg>';
const member = {username: 'yomitan-member', password: 'member-password'};

const sampleIndex = {title: 'Sample', format: 3, revision: '1', sequenced: true};
const sample = (index = {}) => makeDictionary({...sampleIndex, ...index}, {
    'term_bank_1.json': [
        ['語', 'ご', '', '', 0, ['word', {type: 'image', path: 'img/pic.png'}, {type: 'image', path: 'img/pic.svg'}], 1, ''],
    ],
    'kanji_bank_1.json': [['語', 'ゴ', 'かた.る', '', ['word'], {}]],
    'img/pic.png': png,
    'img/pic.svg': scriptedSvg,
});

/** A dictionary large enough for an import to be seen running. */
const bulky = (rows, index = {}) => {
    const banks = {};
    for (let bank = 0; bank < 10; bank++) {
        banks[`term_bank_${bank + 1}.json`] = Array.from({length: rows / 10}, (_, i) => [`語${bank}-${i}`, 'ご', '', '', 0, ['word'], i, '']);
    }

    return makeDictionary({...sampleIndex, title: 'Bulky', ...index}, banks);
};

let admin;
let user;
let anonymous;

async function ensureMember() {
    const users = await (await admin.send('/Users')).json();
    if (!users.some(({Name: name}) => name === member.username)) {
        const response = await admin.send('/Users/New', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({Name: member.username, Password: member.password}),
        });
        expect(response.ok).toBe(true);
    }
}

const titles = async () => (await (await admin.list()).json()).dictionaries.map(({title}) => title);

const lookup = (client, term, dictionaries = ['Sample']) => client.query([{op: 'findTermsBulk', termList: [term], dictionaries, matchType: 'exact'}]);

const rowsOf = async (response) => {
    expect(response.status).toBe(200);
    return (await response.json()).results[0].rows;
};

test.describe.configure({mode: 'serial'});

test.beforeAll(async () => {
    admin = await clientFor(credentials.username, credentials.password);
    await ensureMember();
    user = await clientFor(member.username, member.password);
    anonymous = await clientFor();
    await deleteAll(admin);
});

test.beforeEach(async () => {
    await deleteAll(admin);
});

test.afterAll(async () => {
    await deleteAll(admin);
});

test.describe('authorization', () => {
    let jobId;

    test.beforeEach(async () => {
        ({id: jobId} = await (await admin.upload(sample())).json());
        await waitForJob(admin, jobId);
    });

    const allRequests = (client) => ({
        list: () => client.list(),
        job: () => client.job(jobId),
        query: () => lookup(client, '語'),
        media: () => client.media('Sample', 'img/pic.png'),
        upload: () => client.upload(sample({title: 'Other'})),
        delete: () => client.remove('Sample'),
    });

    test('anonymous requests get 401 everywhere', async () => {
        for (const [name, request] of Object.entries(allRequests(anonymous))) {
            expect((await request()).status, name).toBe(401);
        }
    });

    test('a bad token gets 401', async () => {
        const headers = {Authorization: 'MediaBrowser Client="x", Device="x", DeviceId="x", Version="1", Token="deadbeef"'};
        expect((await fetch(`${server.url}/Yomitan/Dictionaries`, {headers})).status).toBe(401);
    });

    test('a real non-admin account can read but gets 403 on upload and delete', async () => {
        const me = await (await user.send('/Users/Me')).json();
        expect(me.Policy.IsAdministrator).toBe(false);

        const requests = allRequests(user);
        for (const name of ['list', 'job', 'query', 'media']) {
            expect((await requests[name]()).status, name).toBe(200);
        }

        expect((await requests.upload()).status).toBe(403);
        expect((await requests.delete()).status).toBe(403);

        expect(await titles()).toEqual(['Sample']);
        expect(spooledUploads()).toEqual([]);
        expect((await rowsOf(await lookup(user, '語'))).length).toBe(1);
    });

    test('an admin can do all of it', async () => {
        const requests = allRequests(admin);
        for (const name of ['list', 'job', 'query', 'media']) {
            expect((await requests[name]()).status, name).toBe(200);
        }

        expect((await requests.upload()).status).toBe(202);
        expect((await requests.delete()).status).toBe(202);
    });
});

test.describe('uploads', () => {
    test('survive a body well past the server\'s 30 MB default', async () => {
        const padding = 'x'.repeat(100_000);
        const rows = Array.from({length: 450}, (_, i) => [`大${i}`, 'だい', '', '', 0, [padding], i, '']);
        const archive = makeZip([
            {name: 'index.json', data: JSON.stringify({...sampleIndex, title: 'Big'})},
            {name: 'term_bank_1.json', data: JSON.stringify(rows), stored: true},
        ]);
        expect(archive.length).toBeGreaterThan(40 * 1024 * 1024);

        const job = await importArchive(admin, archive);

        expect(job.error).toBeNull();
        expect(job.result.counts.terms.total).toBe(450);
        const [row] = await rowsOf(await lookup(admin, '大449', ['Big']));
        expect(row.definitions[0].length).toBe(padding.length);
    });

    test('do not depend on the content type, even a form type that MVC would try to parse', async () => {
        for (const contentType of ['application/octet-stream', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
            const job = await importArchive(admin, sample({title: contentType}), {contentType});
            expect(job.error, contentType).toBeNull();
        }
    });

    test('return before the import, which reports progress while queries keep working', async () => {
        test.setTimeout(120_000);
        await importArchive(admin, sample());

        const response = await admin.upload(bulky(150_000));
        expect(response.status).toBe(202);
        expect(response.headers.get('location')).toContain('/Yomitan/Jobs/');
        const accepted = await response.json();
        expect(['queued', 'running']).toContain(accepted.state);

        const seen = [];
        let job = accepted;
        while (job.state !== 'succeeded' && job.state !== 'failed') {
            const start = Date.now();
            const rows = await rowsOf(await lookup(user, '語'));
            expect(rows.length).toBe(1);
            seen.push({took: Date.now() - start, rows: job.progress.rows, fraction: job.progress.fraction, phase: job.phase, state: job.state});
            job = await (await user.job(accepted.id)).json();
        }

        expect(job.error).toBeNull();
        expect(job.result.counts.terms.total).toBe(150_000);
        expect(job.progress.fraction).toBe(1);

        const running = seen.filter(({state, rows}) => state === 'running' && rows > 0);
        expect(running.length).toBeGreaterThan(3);
        expect(new Set(running.map(({fraction}) => fraction)).size).toBeGreaterThan(2);
        for (let i = 1; i < running.length; i++) {
            expect(running[i].rows).toBeGreaterThanOrEqual(running[i - 1].rows);
        }

        expect(seen.map(({phase}) => phase)).toContain('terms');
        expect(Math.max(...seen.map(({took}) => took))).toBeLessThan(2000);
    });

    test('of nothing, or with a bad flag, are refused at once', async () => {
        expect((await admin.upload(Buffer.alloc(0))).status).toBe(400);
        const response = await admin.send('/Yomitan/Dictionaries?replace=maybe', {method: 'POST', body: sample()});
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe('invalid_request');
        expect(spooledUploads()).toEqual([]);
    });

    test('that are abandoned leave nothing and do not use up the queue', async () => {
        const abandon = () => new Promise((resolve) => {
            const url = new URL(`${server.url}/Yomitan/Dictionaries`);
            const request = http.request(url, {
                method: 'POST',
                headers: {
                    Authorization: `MediaBrowser Client="t", Device="t", DeviceId="yomitan-abandon", Version="1", Token="${admin.token}"`,
                    'Content-Length': 10_000_000,
                },
            });
            request.on('error', resolve);
            request.write(Buffer.alloc(1_000_000), () => setTimeout(() => {
                request.destroy();
                resolve();
            }, 50));
        });

        for (let i = 0; i < 9; i++) {
            await abandon();
        }

        await expect.poll(spooledUploads).toEqual([]);
        expect((await importArchive(admin, sample())).error).toBeNull();
    });
});

test.describe('hostile archives', () => {
    const deflated = (size) => Buffer.concat([Buffer.from('['), Buffer.alloc(size, ' '), Buffer.from(']')]);
    const index = {name: 'index.json', data: JSON.stringify(sampleIndex)};

    const cases = {
        'a traversal path': [() => makeZip([index, {name: '../../../../tmp/evil.png', data: 'x'}]), 'unsafe_path'],
        'an absolute path': [() => makeZip([index, {name: '/etc/cron.d/evil', data: 'x'}]), 'unsafe_path'],
        'a backslash traversal': [() => makeZip([index, {name: '..\\..\\evil.png', data: 'x'}]), 'unsafe_path'],
        'a glossary that points outside the archive': [
            () => makeDictionary(sampleIndex, {'term_bank_1.json': [['語', 'ご', '', '', 0, [{type: 'image', path: '../../../etc/passwd'}], 1, '']]}),
            'unsafe_path',
        ],
        'a bank over the decompressed limit': [() => makeZip([index, {name: 'term_bank_1.json', data: deflated(270 * 1024 * 1024)}]), 'limit_exceeded'],
        'a bomb under a false size': [() => makeZip([index, {name: 'term_bank_1.json', data: deflated(270 * 1024 * 1024), declaredSize: 16}]), 'invalid_bank'],
        'a stored bank under a false size': [() => makeZip([index, {name: 'term_bank_1.json', data: deflated(270 * 1024 * 1024), declaredSize: 16, stored: true}]), 'limit_exceeded'],
        'a missing index': [() => makeZip([{name: 'term_bank_1.json', data: '[]'}]), 'missing_index'],
        'an index in a subdirectory': [() => makeZip([{name: 'sub/index.json', data: JSON.stringify(sampleIndex)}]), 'missing_index'],
        'a format version from the future': [() => makeDictionary({...sampleIndex, format: 4}), 'invalid_index'],
        'a bank that is not JSON': [() => makeDictionary(sampleIndex, {'term_bank_1.json': '[[broken'}), 'invalid_bank'],
        'a row that breaks the schema': [
            () => makeDictionary(sampleIndex, {
                'term_bank_1.json': [['良', 'りょう', '', '', 0, ['good'], 1, '']],
                'term_bank_2.json': [['語', 'ご', '', '', 'not a number', [], 1, '']],
            }),
            'invalid_bank',
        ],
        'something that is not a zip': [() => Buffer.from('<html>definitely not a zip</html>'.repeat(20)), 'invalid_archive'],
    };

    for (const [name, [build, code]] of Object.entries(cases)) {
        test(`${name} fails cleanly with nothing left behind`, async () => {
            await importArchive(admin, sample({title: 'Bystander'}));
            const before = await (await admin.list()).json();

            const job = await importArchive(admin, build());

            expect(job.state).toBe('failed');
            expect(job.error.code).toBe(code);
            expect(job.error.message.length).toBeGreaterThan(0);
            expect(job.result).toBeNull();

            const after = await (await admin.list()).json();
            expect(after.dictionaries).toEqual(before.dictionaries);
            expect(spooledUploads()).toEqual([]);
            expect(inContainer('ls', '-A', '/tmp')).not.toContain('evil');
            expect((await rowsOf(await lookup(admin, '良', ['Sample', 'Bystander']))).length).toBe(0);
        });
    }
});

test.describe('replacing', () => {
    test('needs asking for', async () => {
        await importArchive(admin, sample());
        const job = await importArchive(admin, sample({revision: '2'}));
        expect(job.state).toBe('failed');
        expect(job.error.code).toBe('already_exists');
        const {dictionaries: [{summary}]} = await (await admin.list()).json();
        expect(summary.revision).toBe('1');
    });

    test('swaps the content when asked', async () => {
        await importArchive(admin, sample());
        const job = await importArchive(admin, sample({revision: '2'}), {replace: true});
        expect(job.error).toBeNull();
        expect(job.result.replaced).toBe(true);
        const {dictionaries} = await (await admin.list()).json();
        expect(dictionaries.map(({summary: {revision}}) => revision)).toEqual(['2']);
    });

    test('leaves the previous version whole if the import fails midway', async () => {
        await importArchive(admin, sample());
        const before = await (await admin.list()).json();
        const rowsBefore = await rowsOf(await lookup(admin, '語'));

        const failing = makeDictionary({...sampleIndex, revision: '2'}, {
            'term_bank_1.json': [['新', 'しん', '', '', 0, ['new'], 1, '']],
            'kanji_bank_1.json': [['新', 'シン', '', '', ['new'], {}]],
            'tag_bank_1.json': [['bad row']],
        });
        const job = await importArchive(admin, failing, {replace: true});

        expect(job.state).toBe('failed');
        expect(job.error.code).toBe('invalid_bank');
        expect(job.progress.rows).toBeGreaterThan(0); // It failed well into the work, not at the first file.
        expect((await (await admin.list()).json()).dictionaries).toEqual(before.dictionaries);
        expect(await rowsOf(await lookup(admin, '語'))).toEqual(rowsBefore);
        expect((await rowsOf(await lookup(admin, '新'))).length).toBe(0);
        expect((await admin.media('Sample', 'img/pic.png')).status).toBe(200);
    });

    test('survives the server being killed midway', async () => {
        test.setTimeout(120_000);
        await importArchive(admin, sample({title: 'Bulky'}));
        const before = await (await admin.list()).json();

        const {id} = await (await admin.upload(bulky(150_000, {revision: '2'}), {replace: true})).json();
        await expect.poll(async () => (await (await admin.job(id)).json()).progress.rows, {intervals: [20]}).toBeGreaterThan(5000);
        execFileSync('podman', ['kill', '--signal', 'KILL', server.name]);
        execFileSync('podman', ['start', server.name]);

        await expect.poll(async () => {
            try {
                return (await admin.list()).status;
            } catch {
                return 0;
            }
        }, {timeout: 60_000, intervals: [500]}).toBe(200);

        expect((await (await admin.list()).json()).dictionaries).toEqual(before.dictionaries);
        expect((await rowsOf(await lookup(admin, '語', ['Bulky']))).length).toBe(1);
        expect(spooledUploads()).toEqual([]);
        expect((await admin.job(id)).status).toBe(404);
    });
});

test.describe('deleting', () => {
    test('is a job that removes everything, including the images', async () => {
        await importArchive(admin, sample());
        const response = await admin.remove('Sample');
        expect(response.status).toBe(202);
        const {id, kind, title} = await response.json();
        expect(kind).toBe('delete');
        expect(title).toBe('Sample');
        expect((await waitForJob(admin, id)).state).toBe('succeeded');
        expect(await titles()).toEqual([]);
        expect((await rowsOf(await lookup(admin, '語'))).length).toBe(0);
        expect((await admin.media('Sample', 'img/pic.png')).status).toBe(404);
    });

    test('answers 404 for an unknown title', async () => {
        const response = await admin.remove('Nothing Like This');
        expect(response.status).toBe(404);
        expect((await response.json()).error.code).toBe('not_found');
    });

    test('takes a title with awkward characters', async () => {
        const title = 'A/B C&D?e=f #1 日本語';
        await importArchive(admin, sample({title}));
        expect(await titles()).toEqual([title]);
        const {id} = await (await admin.remove(title)).json();
        await waitForJob(admin, id);
        expect(await titles()).toEqual([]);
    });

    test('gives the disk space back', async () => {
        test.setTimeout(120_000);
        await importArchive(admin, bulky(150_000));
        const {databaseBytes: full, dictionaries: [{sizeBytes}]} = await (await admin.list()).json();
        expect(sizeBytes).toBeGreaterThan(5_000_000);
        expect(sizeBytes).toBeLessThanOrEqual(full);

        await deleteAll(admin);
        const {databaseBytes, freeBytes} = await (await admin.list()).json();
        expect(databaseBytes).toBeLessThan(full - (sizeBytes / 2));
        expect(freeBytes).toBeLessThan(sizeBytes / 2);
    });
});

test.describe('media', () => {
    test.beforeEach(async () => {
        await importArchive(admin, sample());
    });

    test('serves the bytes with the type from the fixed table, unsniffable', async () => {
        const response = await user.media('Sample', 'img/pic.png');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('content-disposition')).toBe('inline');
        expect(response.headers.get('content-security-policy')).toContain('sandbox');
        expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
    });

    test('revalidates with an ETag', async () => {
        const first = await user.media('Sample', 'img/pic.png');
        const etag = first.headers.get('etag');
        expect(etag).toBeTruthy();
        const second = await user.send('/Yomitan/Media?dictionary=Sample&path=img%2Fpic.png', {headers: {'If-None-Match': etag}});
        expect(second.status).toBe(304);
    });

    test('never renders SVG as a page', async ({page}) => {
        const response = await user.media('Sample', 'img/pic.svg');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/svg+xml');
        expect(response.headers.get('content-disposition')).toBe('attachment');
        expect(response.headers.get('content-security-policy')).toContain('sandbox');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');

        // A real browser opening the URL, with the token, must not run the script on the server's origin.
        let dialog = false;
        page.on('dialog', async (shown) => {
            dialog = true;
            await shown.dismiss();
        });
        await page.setExtraHTTPHeaders({Authorization: `MediaBrowser Client="t", Device="t", DeviceId="yomitan-svg", Version="1", Token="${admin.token}"`});
        await page.goto('about:blank');
        await page.goto(`${server.url}/Yomitan/Media?dictionary=Sample&path=img%2Fpic.svg`).catch(() => {});
        await page.waitForTimeout(300);
        expect(dialog).toBe(false);
    });

    for (const path of ['../../dictionaries.db', '..%2f..%2fdictionaries.db', '/etc/passwd', 'img/../img/pic.png', '..\\pic.png']) {
        test(`refuses the path ${path}`, async () => {
            const response = await user.send(`/Yomitan/Media?dictionary=Sample&path=${path}`);
            expect(response.status).toBe(400);
            expect((await response.json()).error.code).toBe('unsafe_path');
        });
    }

    test('answers 404 for what is not there', async () => {
        expect((await user.media('Sample', 'img/none.png')).status).toBe(404);
        expect((await user.media('Other', 'img/pic.png')).status).toBe(404);
        expect((await user.send('/Yomitan/Media?dictionary=Sample')).status).toBe(400);
    });
});

test.describe('queries', () => {
    test('refuse what they cannot run', async () => {
        const send = (body) => user.send('/Yomitan/Query', {method: 'POST', body, headers: {'Content-Type': 'application/json'}});
        expect((await (await send('{not json')).json()).error.code).toBe('invalid_json');
        expect((await (await send('{}')).json()).error.code).toBe('invalid_request');
        const tooMany = JSON.stringify({operations: Array.from({length: 65}, () => ({op: 'getDictionaryInfo'}))});
        expect((await (await send(tooMany)).json()).error.code).toBe('too_many_operations');
        const huge = await send(JSON.stringify({operations: [], padding: 'x'.repeat(5 * 1024 * 1024)}));
        expect(huge.status).toBe(413);
    });

    test('work with a form content type too', async () => {
        const response = await user.send('/Yomitan/Query', {
            method: 'POST',
            body: JSON.stringify({operations: [{op: 'getDictionaryInfo'}]}),
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        });
        expect(response.status).toBe(200);
    });
});

test('the database is the plugin\'s own file, away from Jellyfin\'s', async () => {
    await importArchive(admin, sample());
    const files = inContainer('ls', '-A', '/config/data/yomitan').split('\n');
    expect(files).toContain('dictionaries.db');
    expect(inContainer('ls', '-A', '/config/data').split('\n')).toContain('jellyfin.db');
    expect(inContainer('sh', '-c', 'grep -c "dict_id" /config/data/jellyfin.db || true').trim()).toBe('0');
});
