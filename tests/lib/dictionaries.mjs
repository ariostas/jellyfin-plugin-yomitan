// Helpers for the plugin's dictionary API. Everything here goes over HTTP, as a real client would.
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {expect} from '@playwright/test';
import {server} from './jellyfin.mjs';
import {makeZip} from './zip.mjs';

const authHeader = 'MediaBrowser Client="yomitan-tests", Device="tests", DeviceId="yomitan-tests-dict", Version="1"';

export const yomitanTestData = new URL('../../third_party/yomitan/test/data/', import.meta.url).pathname;

/** Logs in and returns a client whose methods send that user's token, or none. */
export async function clientFor(username, password) {
    let token;
    if (username !== undefined) {
        const response = await fetch(`${server.url}/Users/AuthenticateByName`, {
            method: 'POST',
            headers: {Authorization: authHeader, 'Content-Type': 'application/json'},
            body: JSON.stringify({Username: username, Pw: password}),
        });
        expect(response.ok).toBe(true);
        ({AccessToken: token} = await response.json());
    }

    const headers = token ? {Authorization: `${authHeader}, Token="${token}"`} : {};
    const send = (path, init = {}) => fetch(server.url + path, {...init, headers: {...headers, ...init.headers}});

    return {
        send,
        token,
        upload: (body, {replace = false, contentType = 'application/zip'} = {}) => send(
            `/Yomitan/Dictionaries${replace ? '?replace=true' : ''}`,
            {method: 'POST', body, headers: {'Content-Type': contentType}},
        ),
        remove: (title) => send(`/Yomitan/Dictionaries?title=${encodeURIComponent(title)}`, {method: 'DELETE'}),
        list: () => send('/Yomitan/Dictionaries'),
        job: (id) => send(`/Yomitan/Jobs/${id}`),
        query: (operations) => send('/Yomitan/Query', {
            method: 'POST',
            body: JSON.stringify({operations}),
            headers: {'Content-Type': 'application/json'},
        }),
        media: (dictionary, path) => send(`/Yomitan/Media?dictionary=${encodeURIComponent(dictionary)}&path=${encodeURIComponent(path)}`),
    };
}

/** Polls a job until it ends and returns its final state. */
export async function waitForJob(client, id, {timeout = 120_000} = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const job = await (await client.job(id)).json();
        if (job.state === 'succeeded' || job.state === 'failed') {
            return job;
        }

        expect(Date.now(), `job ${id} is stuck: ${JSON.stringify(job)}`).toBeLessThan(deadline);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

/** Uploads an archive and waits for the import to end. */
export async function importArchive(client, body, options) {
    const response = await client.upload(body, options);
    expect(response.status).toBe(202);
    const {id} = await response.json();
    return waitForJob(client, id);
}

/** Deletes every dictionary, so a spec starts from a known state. */
export async function deleteAll(client) {
    const {dictionaries} = await (await client.list()).json();
    for (const {title} of dictionaries) {
        const response = await client.remove(title);
        expect(response.status).toBe(202);
        const {id} = await response.json();
        expect((await waitForJob(client, id)).state).toBe('succeeded');
    }
}

/** Zips a dictionary directory from Yomitan's test data, in sorted order, which fixes the row ids. */
export function zipTestDictionary(name, {title} = {}) {
    const directory = join(yomitanTestData, 'dictionaries', name);
    return makeZip(readdirSync(directory).sort().map((file) => {
        let data = readFileSync(join(directory, file));
        if (file === 'index.json' && title) {
            data = JSON.stringify({...JSON.parse(data.toString('utf8')), title});
        }

        return {name: file, data};
    }));
}

/** Runs a command in the server's container, for looking at what is left on its disk. */
export function inContainer(...command) {
    return execFileSync('podman', ['exec', server.name, ...command], {encoding: 'utf8'});
}

/** Lists the spooled uploads on the server, which must be empty when no job is pending. */
export function spooledUploads() {
    return inContainer('ls', '-A', '/config/data/yomitan/uploads').split('\n').filter(Boolean);
}
