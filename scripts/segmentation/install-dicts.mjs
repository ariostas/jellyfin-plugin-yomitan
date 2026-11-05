// Installs the dictionaries the segmentation scorer runs against, on a server from scripts/dev.sh, unless they are
// already there. Usage: node install-dicts.mjs <server url> <zip>...
//
// A dictionary is matched by the title in its index.json, so a new release of one is imported beside the old.
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {execFileSync} from 'node:child_process';

const [server, ...zips] = process.argv.slice(2);
const auth = 'MediaBrowser Client="yomitan-segmentation", Device="segmentation", DeviceId="yomitan-segmentation", Version="1"';

async function logIn() {
    const response = await fetch(`${server}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: {Authorization: auth, 'Content-Type': 'application/json'},
        body: JSON.stringify({Username: 'spike', Pw: 'spike'}),
    });
    if (!response.ok) {
        throw new Error(`Logging in returned ${response.status}`);
    }

    return (await response.json()).AccessToken;
}

const token = await logIn();
const send = async (path, init = {}) => {
    const response = await fetch(server + path, {...init, headers: {Authorization: `${auth}, Token="${token}"`, ...init.headers}});
    if (!response.ok) {
        throw new Error(`${init.method ?? 'GET'} ${path} returned ${response.status}: ${await response.text()}`);
    }

    return response.json();
};

// unzip is only asked for the one small file, so the archive is never unpacked here.
const titleOf = (zip) => JSON.parse(execFileSync('unzip', ['-p', zip, 'index.json'], {encoding: 'utf8'})).title;

const installed = new Set((await send('/Yomitan/Dictionaries')).dictionaries.map(({title}) => title));
for (const zip of zips) {
    const title = titleOf(zip);
    if (installed.has(title)) {
        console.log(`${title} is installed`);
        continue;
    }

    console.log(`Importing ${title} from ${basename(zip)}`);
    const {id} = await send('/Yomitan/Dictionaries', {
        method: 'POST',
        body: readFileSync(zip),
        headers: {'Content-Type': 'application/zip'},
    });
    for (;;) {
        const job = await send(`/Yomitan/Jobs/${id}`);
        if (job.state === 'failed') {
            throw new Error(`Importing ${title} failed: ${JSON.stringify(job.error)}`);
        }

        if (job.state === 'succeeded') {
            break;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}
