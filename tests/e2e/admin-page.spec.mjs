// The dashboard page, through its real UI, as the admin signed in. Everything a dictionary says about itself is hostile
// here: a zip's title goes on screen, and has to stay text.
import {execFileSync} from 'node:child_process';
import {statSync} from 'node:fs';
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {createUser, credentials, deleteUser, getMovies, logIn, play, server} from '../lib/jellyfin.mjs';
import {expectPopup, isPaused, LINES, moveToWord, parkMouse, showLine, startLookupFilm} from '../lib/lookup.mjs';
import {makeMiniDictionary} from '../lib/mini-dictionary.mjs';
import {jellyfinLine} from '../lib/player.mjs';
import {expect, test} from '../lib/test.mjs';
import {makeDictionary, makeZip} from '../lib/zip.mjs';

test.describe.configure({timeout: 120_000});

const HOSTILE_TITLE = '<img src=x onerror="window.attacked=1"><script>window.attacked=2</script>${7*7}&amp;';

let admin;

test.beforeAll(async () => {
    admin = await clientFor(credentials.username, credentials.password);
});

test.beforeEach(async () => {
    await deleteAll(admin);
});

test.afterAll(async () => {
    await deleteAll(admin);
});

const file = (name, buffer) => ({name, mimeType: 'application/zip', buffer});

async function openPage(page) {
    await logIn(page);
    await page.goto('web/#/configurationpage?name=yomitan');
    await page.locator('#yomitanFile').waitFor({state: 'attached'});
}

async function upload(page, input) {
    await page.locator('#yomitanFile').setInputFiles(input);
    await page.locator('#yomitanUpload').click();
}

const message = (page) => page.locator('#yomitanMessage');
const rows = (page) => page.locator('.yomitan-dictionary');
const installed = async () => (await (await admin.list()).json()).dictionaries.map(({title}) => title);

test('an admin finds it in the dashboard\'s menu, under any BaseUrl', async ({page, isMobile}) => {
    test.skip(isMobile, 'On a phone that menu is in a drawer. The next test opens the page there.');
    await logIn(page);
    await page.goto('web/#/dashboard');
    const entry = page.getByRole('link', {name: 'Yomitan'});
    await entry.click();
    await page.locator('#yomitanFile').waitFor({state: 'attached'});
    expect(new URL(page.url()).pathname).toBe(`${server.prefix}/web/`);
    expect(page.url()).toContain('#/configurationpage?name=yomitan');
});

test('a file goes up, shows its progress, and joins the list with its numbers', async ({page}) => {
    await openPage(page);
    await expect(page.locator('#yomitanList')).toContainText('Nothing is installed');
    await expect(page.locator('#yomitanUpload')).toBeDisabled();

    await upload(page, file('mini.zip', makeMiniDictionary()));
    await expect(message(page)).toContainText('Mini is installed');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Mini');
    await expect(rows(page).first()).toContainText('93 words');
    await expect(page.locator('#yomitanTransfer')).toHaveJSProperty('value', 1);
    await expect(page.locator('#yomitanImport')).toHaveJSProperty('value', 1);
    expect(await installed()).toEqual(['Mini']);
    await expect(page.locator('#yomitanTotals')).toContainText('on disk');
});

test('a title that exists is refused, and replacing it is one clear step', async ({page}) => {
    const first = makeDictionary({title: 'Same', format: 3, revision: 'one', sequenced: true}, {'term_bank_1.json': [['猫', 'ねこ', '', '', 0, ['first'], 1, '']]});
    const second = makeDictionary({title: 'Same', format: 3, revision: 'two', sequenced: true}, {'term_bank_1.json': [['猫', 'ねこ', '', '', 0, ['second'], 1, '']]});
    expect((await importArchive(admin, first)).state).toBe('succeeded');
    await openPage(page);
    await upload(page, file('same.zip', second));
    await expect(message(page)).toContainText('already installed');
    await expect(message(page)).toContainText('Same');
    await expect(rows(page).first()).toContainText('Revision one');

    await page.locator('.yomitan-keep').click();
    await expect(page.locator('.yomitan-replace')).toHaveCount(0);
    await expect(rows(page).first()).toContainText('Revision one');

    await page.locator('#yomitanUpload').click();
    await page.locator('.yomitan-replace').click();
    await expect(message(page)).toContainText('Same is installed');
    await expect(rows(page).first()).toContainText('Revision two');
    const {results} = await (await admin.query([{op: 'findTermsBulk', termList: ['猫'], dictionaries: ['Same'], matchType: 'exact'}])).json();
    expect(results[0].rows[0].definitions).toEqual(['second']);
});

test.describe('what goes wrong is said in plain words', () => {
    const cases = [
        ['a file that is no zip', Buffer.from('this is not a zip'), 'not a readable zip'],
        ['a zip with no index', makeZip([{name: 'readme.txt', data: Buffer.from('hello')}]), 'no index.json'],
        ['a bad index', makeZip([{name: 'index.json', data: Buffer.from('{"title": 1}')}]), 'index.json is damaged'],
        ['a bad bank', makeDictionary({title: 'Bad', format: 3, revision: '1'}, {'term_bank_1.json': [['only one field']]}), 'data is damaged'],
        ['an empty file', Buffer.alloc(0), 'The file is empty'],
    ];

    for (const [name, buffer, text] of cases) {
        test(name, async ({page}) => {
            await openPage(page);
            await upload(page, file('bad.zip', buffer));
            await expect(message(page)).toContainText(text);
            await expect(message(page)).toHaveAttribute('data-kind', 'error');
            await expect(page.locator('.yomitan-replace')).toHaveCount(0);
            await expect(page.locator('#yomitanProgress')).toBeHidden();
            expect(await installed()).toEqual([]);
        });
    }

    test('the server going away during the upload', async ({page}) => {
        await openPage(page);
        await page.route('**/Yomitan/Dictionaries', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()));
        await upload(page, file('mini.zip', makeMiniDictionary()));
        await expect(message(page)).toContainText('could not be reached');
        await page.unroute('**/Yomitan/Dictionaries');
    });
});

test('a hostile title stays text, on this page and in every message', async ({page}) => {
    await openPage(page);
    const archive = makeDictionary({title: HOSTILE_TITLE, format: 3, revision: '<b>1</b>', sequenced: true, author: '<img src=x onerror="window.attacked=3">', description: '<script>window.attacked=4</script>'}, {
        'term_bank_1.json': [['猫', 'ねこ', '', '', 0, ['cat'], 1, '']],
    });

    await upload(page, file('hostile.zip', archive));
    await expect(message(page)).toContainText('is installed');
    await expect(rows(page).first().locator('.yomitan-dictionary-title')).toHaveText(HOSTILE_TITLE);
    await expect(message(page)).toContainText(HOSTILE_TITLE);

    await upload(page, file('hostile.zip', archive));
    await expect(message(page)).toContainText('already installed');
    await expect(message(page)).toContainText(HOSTILE_TITLE);

    await page.locator('.yomitan-delete').click();
    await page.locator('.yomitan-confirm-delete').click();
    await expect(message(page)).toContainText('is deleted');
    await expect(message(page)).toContainText(HOSTILE_TITLE);

    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.attacked)).toBeUndefined();
    expect(await page.locator('.yomitan-admin img, .yomitan-admin script, .yomitan-admin b').count()).toBe(0);
});

test('a very long title wraps, and the page does not scroll sideways', async ({page}) => {
    await importArchive(admin, makeDictionary({title: 'x'.repeat(600), format: 3, revision: '1'}, {'term_bank_1.json': [['猫', 'ねこ', '', '', 0, ['cat'], 1, '']]}));
    await openPage(page);
    await expect(rows(page)).toHaveCount(1);
    expect(await page.evaluate(() => {
        const container = document.querySelector('.yomitan-admin');
        return container.scrollWidth - container.clientWidth;
    })).toBeLessThanOrEqual(0);
});

test('deleting asks first, and keeping keeps', async ({page}) => {
    await importArchive(admin, makeMiniDictionary());
    await openPage(page);
    await page.locator('.yomitan-delete').click();
    await expect(page.locator('.yomitan-dictionary-actions')).toContainText('Delete this for everyone?');
    expect(await installed()).toEqual(['Mini']);

    await page.locator('.yomitan-cancel-delete').click();
    await expect(page.locator('.yomitan-confirm-delete')).toHaveCount(0);
    expect(await installed()).toEqual(['Mini']);

    await page.locator('.yomitan-delete').click();
    await page.locator('.yomitan-confirm-delete').click();
    await expect(message(page)).toContainText('Mini is deleted');
    await expect(rows(page)).toHaveCount(0);
    expect(await installed()).toEqual([]);
});

test('a file is streamed: nothing reads it into the page', async ({page}) => {
    await openPage(page);
    await page.evaluate(() => {
        window.reads = [];
        const note = (object, name) => {
            const original = object[name];
            object[name] = function (...args) {
                window.reads.push(name);
                return original.apply(this, args);
            };
        };

        note(Blob.prototype, 'arrayBuffer');
        note(Blob.prototype, 'text');
        note(Blob.prototype, 'stream');
        note(Blob.prototype, 'slice');
        note(FileReader.prototype, 'readAsArrayBuffer');
        note(FileReader.prototype, 'readAsBinaryString');
        note(FileReader.prototype, 'readAsDataURL');
        note(FileReader.prototype, 'readAsText');
        const {send} = XMLHttpRequest.prototype;
        XMLHttpRequest.prototype.send = function (body) {
            window.sent = body instanceof File ? 'the File itself' : typeof body;
            return send.call(this, body);
        };
    });
    await upload(page, file('mini.zip', makeMiniDictionary()));
    await expect(message(page)).toContainText('is installed');
    expect(await page.evaluate(() => ({reads: window.reads, sent: window.sent}))).toEqual({reads: [], sent: 'the File itself'});
});

test('a non-admin gets no page, and the API refuses them anyway', async ({page}) => {
    const user = await createUser('notadmin');
    await logIn(page, {user});
    await page.goto('web/#/configurationpage?name=yomitan');
    await page.waitForTimeout(1500);
    await expect(page.locator('#yomitanFile')).toHaveCount(0);
    const client = await clientFor(user.username, user.password);
    expect((await client.upload(makeMiniDictionary())).status).toBe(403);
    await deleteUser(user);
});

test.describe('dictionaries through the page, with playback', () => {
    test('a dictionary uploaded here works in playback, and deleting it here takes the overlay away', async ({page, isMobile}) => {
        test.skip(isMobile, 'The mouse is the short way, and touch has its own tests.');
        await openPage(page);
        await upload(page, file('mini.zip', makeMiniDictionary()));
        await expect(message(page)).toContainText('Mini is installed');

        await startLookupFilm(page);
        await parkMouse(page);
        await showLine(page, LINES.plain);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
        await parkMouse(page);
        await expect.poll(() => isPaused(page)).toBe(false);

        // In a second tab, as the same admin, with the film going on in this one.
        const second = await page.context().newPage();
        await second.goto('web/#/configurationpage?name=yomitan');
        await second.locator('.yomitan-delete').click();
        await second.locator('.yomitan-confirm-delete').click();
        await expect(second.locator('#yomitanMessage')).toContainText('Mini is deleted');
        await second.close();

        // The next line looked up finds nothing and the session gives the line back to Jellyfin.
        await page.evaluate(() => window.__yomitanJellyfin.playback.engine.prefetch(['知らない言葉']));
        await page.waitForFunction(() => window.__yomitanJellyfin.playback.session?.state === 'inactive');
        expect(await page.locator('.yomitan-overlay').count()).toBe(0);
        await expect.poll(() => jellyfinLine(page)).toBe('showing');
    });
});

const directory = process.env.YOMITAN_REAL_DICTS;

test.describe('real dictionaries', () => {
    test.skip(!directory, 'Needs YOMITAN_REAL_DICTS.');
    test.setTimeout(240_000);

    async function watchProgress(page) {
        await page.evaluate(() => {
            window.seen = {transfer: [], import: [], phases: []};
            const sample = () => {
                const {transfer, import: imported, phases} = window.seen;
                const transferred = document.querySelector('#yomitanTransfer')?.value;
                const fraction = document.querySelector('#yomitanImport')?.value;
                const phase = document.querySelector('#yomitanImportText')?.textContent;
                if (transfer.at(-1) !== transferred) {
                    transfer.push(transferred);
                }

                if (imported.at(-1) !== fraction) {
                    imported.push(fraction);
                }

                if (phases.at(-1) !== phase) {
                    phases.push(phase);
                }

                window.seenTimer = setTimeout(sample, 15);
            };
            sample();
        });
    }

    const increasing = (values) => values.every((value, index) => index === 0 || value >= values[index - 1]);

    test('JMdict and KANJIDIC go up through the page, with real progress, and work in playback', async ({page, browserName}) => {
        test.skip(browserName !== 'chromium', 'One browser can say this.');
        await openPage(page);
        await watchProgress(page);
        // Slow enough to see the body go up, which on this machine otherwise takes moments.
        const debug = await page.context().newCDPSession(page);
        await debug.send('Network.enable');
        await debug.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 4 * 1024 * 1024});
        await upload(page, `${directory}/JMdict_english.zip`);
        await expect(message(page)).toContainText('is installed', {timeout: 120_000});
        await debug.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});

        const seen = await page.evaluate(() => window.seen);
        console.log('transfer samples', seen.transfer.length, 'import samples', seen.import.length, 'phases', seen.phases.slice(0, 8));
        expect(seen.transfer.filter((value) => value > 0 && value < 1).length).toBeGreaterThan(5);
        expect(increasing(seen.transfer)).toBe(true);
        expect(seen.import.filter((value) => value > 0 && value < 1).length).toBeGreaterThan(5);
        expect(increasing(seen.import)).toBe(true);
        expect(seen.phases.some((phase) => /words, [\d,]+ rows/.test(phase))).toBe(true);

        await upload(page, `${directory}/KANJIDIC_english.zip`);
        await expect(message(page)).toContainText('KANJIDIC', {timeout: 60_000});
        await expect(rows(page)).toHaveCount(2);
        await expect(page.locator('#yomitanList')).toContainText('kanji');

        await startLookupFilm(page);
        await parkMouse(page);
        await showLine(page, LINES.plain);
        await moveToWord(page, '学校');
        await expectPopup(page, '学校');
    });
});

test('a file over 500 MB goes up and the page does not grow with it', async ({page, browserName}) => {
    test.skip(!process.env.YOMITAN_BIG_FILE || browserName !== 'chromium', 'Needs YOMITAN_BIG_FILE, a dictionary of 500 MB or more, and Chromium.');
    test.setTimeout(300_000);
    const {size} = statSync(process.env.YOMITAN_BIG_FILE);
    expect(size).toBeGreaterThan(500e6);
    await openPage(page);

    // The memory of every renderer process on this machine, so it can only overstate what this page uses.
    const renderers = () => execFileSync('ps', ['-eo', 'rss,args'], {encoding: 'utf8'}).split('\n')
        .filter((line) => line.includes('--type=renderer')).map((line) => Number.parseInt(line, 10) * 1024);
    const before = Math.max(...renderers());
    let peak = before;
    const sampler = setInterval(() => {
        peak = Math.max(peak, ...renderers());
    }, 200);
    try {
        await upload(page, process.env.YOMITAN_BIG_FILE);
        await expect(page.locator('#yomitanTransferText')).toContainText('done', {timeout: 200_000});
        await expect(message(page)).toContainText('is installed', {timeout: 200_000});
    } finally {
        clearInterval(sampler);
    }

    console.log(`a file of ${size} bytes: largest renderer ${before} bytes before, ${peak} at the peak`);
    expect(peak - before).toBeLessThan(size / 4);
});
