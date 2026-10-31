// Kills the server, so it has to run after file-transformation.spec.mjs, and specs run in file name order. A restart
// undoes how scripts/dev.sh sets the middleware order: the server rewrites the name it sorts plugins by.
import {execFileSync} from 'node:child_process';
import {expect, test} from '@playwright/test';
import {clientFor, deleteAll, importArchive, spooledUploads} from '../lib/dictionaries.mjs';
import {credentials, server} from '../lib/jellyfin.mjs';
import {makeDictionary} from '../lib/zip.mjs';

const index = {title: 'Bulky', format: 3, sequenced: true};

function bulky(rows) {
    const banks = {};
    for (let bank = 0; bank < 10; bank++) {
        banks[`term_bank_${bank + 1}.json`] = Array.from({length: rows / 10}, (_, i) => [`語${bank}-${i}`, 'ご', '', '', 0, ['word'], i, '']);
    }

    return makeDictionary({...index, revision: '2'}, banks);
}

test('a replacement survives the server being killed midway', async () => {
    test.setTimeout(120_000);
    const admin = await clientFor(credentials.username, credentials.password);
    await deleteAll(admin);

    const original = makeDictionary({...index, revision: '1'}, {'term_bank_1.json': [['語', 'ご', '', '', 0, ['word'], 1, '']]});
    expect((await importArchive(admin, original)).error).toBeNull();
    const before = await (await admin.list()).json();

    const {id} = await (await admin.upload(bulky(150_000), {replace: true})).json();
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
    const lookup = await admin.query([{op: 'findTermsBulk', termList: ['語'], dictionaries: ['Bulky'], matchType: 'exact'}]);
    expect((await lookup.json()).results[0].rows.length).toBe(1);
    expect(spooledUploads()).toEqual([]);
    expect((await admin.job(id)).status).toBe(404);

    await deleteAll(admin);
});
