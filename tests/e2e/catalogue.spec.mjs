// Installs the plugin the way an admin does: a plugin repository added in the dashboard, the plugin installed from its
// catalogue, and the server restarted from the dashboard. Given a second zip, it then upgrades to it the same way, and
// checks that the dictionaries and the settings stay. The manifest is the one scripts/lib/manifest.mjs writes for a
// release, and the zips are what scripts/package.sh makes, served from here.
//
// It needs a server without the plugin, and YOMITAN_CATALOGUE_ZIPS, the zips oldest first, separated by commas. Run it
// with `scripts/test-matrix.sh catalogue`, which sets up both. The server reaches this machine at
// YOMITAN_CATALOGUE_HOST (default host.containers.internal), so the files are served on every interface while it runs.
import {readFileSync} from 'node:fs';
import http from 'node:http';
import {basename} from 'node:path';
import {addVersion, md5, readMeta} from '../../scripts/lib/manifest.mjs';
import {clientFor, importArchive} from '../lib/dictionaries.mjs';
import {api, clientScript, credentials, fillLogin, readSettings, saveSettings, server} from '../lib/jellyfin.mjs';
import {makeMiniDictionary} from '../lib/mini-dictionary.mjs';
import {expect, test} from '../lib/test.mjs';

const zips = (process.env.YOMITAN_CATALOGUE_ZIPS ?? '').split(',').filter(Boolean);
const host = process.env.YOMITAN_CATALOGUE_HOST ?? 'host.containers.internal';
const PLUGIN_ID = '95f2db49f96644b9a94f4784792339fb';

test.skip(zips.length === 0, 'Needs YOMITAN_CATALOGUE_ZIPS and a server without the plugin: scripts/test-matrix.sh catalogue');
test.describe.configure({timeout: 600_000});
test.use({actionTimeout: 30_000});

let files;
let manifest = [];
let repository;

/** Serves the manifest as it stands, and the zips under their own names. */
test.beforeAll(async () => {
    files = new Map(zips.map((path) => [basename(path), readFileSync(path)]));
    repository = http.createServer((request, response) => {
        const name = decodeURIComponent(new URL(request.url, 'http://x').pathname.slice(1));
        const body = name === 'manifest.json' ? JSON.stringify(manifest) : files.get(name);
        response.writeHead(body ? 200 : 404, {'Content-Type': name.endsWith('.zip') ? 'application/zip' : 'application/json'});
        response.end(body);
    });
    await new Promise((resolve) => repository.listen(0, '0.0.0.0', resolve));
});

test.afterAll(async () => {
    await new Promise((resolve) => repository?.close(resolve));
});

const repositoryUrl = () => `http://${host}:${repository.address().port}`;

function publish(zip) {
    manifest = addVersion(manifest, {
        meta: readMeta(zip),
        checksum: md5(readFileSync(zip)),
        sourceUrl: `${repositoryUrl()}/${basename(zip)}`,
        changelog: `- ${readMeta(zip).version}`,
        timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    });
}

/** Presses Install, and the warning's Install if it comes, which is only for a plugin not yet installed. */
async function install(page, button) {
    await button.click();
    const confirm = page.getByRole('dialog').getByRole('button', {name: 'Install'});
    const done = page.getByText('The plugin has been successfully installed');
    await expect(confirm.or(done)).toBeVisible({timeout: 120_000});
    if (await confirm.isVisible()) {
        await confirm.click();
    }
    await expect(done).toBeVisible({timeout: 120_000});
}

/** Restarts through the dashboard, and waits for the server to have done it. */
async function restart(page) {
    const pending = async () => {
        try {
            return (await api('/System/Info')).HasPendingRestart;
        } catch {
            return null;
        }
    };
    expect(await pending()).toBe(true);
    await page.goto('web/#/dashboard');
    await page.getByRole('button', {name: 'Restart'}).click();
    await page.getByRole('dialog').getByRole('button', {name: 'Restart'}).click();
    // While it restarts, the server answers with errors or not at all.
    await expect.poll(pending, {timeout: 180_000, intervals: [2000]}).toBe(false);
}

/** The plugin as the server lists it, and the client in a page loaded afresh. */
async function expectRunning(page, zip) {
    const {version} = readMeta(zip);
    const plugins = (await api('/Plugins')).filter(({Id}) => Id === PLUGIN_ID);
    expect(plugins.map(({Version, Status}) => ({Version, Status}))).toEqual([{Version: version, Status: 'Active'}]);

    await page.goto('web/');
    await page.waitForFunction(() => window.ApiClient?.isLoggedIn());
    await expect(page.locator(clientScript)).toHaveCount(1);
    // The client's version is the release's, which Jellyfin gives a fourth part.
    expect(`${await page.evaluate(() => window.__yomitanJellyfin.version)}.0`).toBe(version);
}

test('a repository URL is all it takes to install, and to upgrade', async ({page}) => {
    expect((await api('/Plugins')).some(({Id}) => Id === PLUGIN_ID), 'the server should start without the plugin').toBe(false);
    publish(zips[0]);

    await test.step('add the repository', async () => {
        await page.goto('web/');
        await fillLogin(page, credentials);
        await page.goto('web/#/dashboard/plugins/repositories');
        await page.getByRole('button', {name: 'New Repository'}).click();
        await page.locator('input[name=Name]').fill('Yomitan');
        await page.locator('input[name=Url]').fill(`${repositoryUrl()}/manifest.json`);
        await page.getByRole('button', {name: 'Add'}).click();
        await expect(page.locator(`a[href="${repositoryUrl()}/manifest.json"]`)).toBeVisible();
    });

    await test.step('install from the catalogue', async () => {
        await page.goto('web/#/dashboard/plugins');
        await page.getByRole('button', {name: 'Available', exact: true}).click();
        await page.locator('a[href*="name=Yomitan"]').click();
        await expect(page.getByText(readMeta(zips[0]).description)).toBeVisible();
        // The version's own button and the page's both install the newest.
        await install(page, page.getByRole('button', {name: 'Install', exact: true}).first());
    });

    await test.step('restart, and it runs', async () => {
        await restart(page);
        await expectRunning(page, zips[0]);
    });

    if (zips.length === 1) {
        return;
    }

    // What an admin and a user have set up has to survive the upgrade.
    const admin = await clientFor(credentials.username, credentials.password);
    expect((await importArchive(admin, makeMiniDictionary())).state).toBe('succeeded');
    await saveSettings(credentials, {enabled: true, hoverDelayMs: 456});
    const settings = await readSettings(credentials);

    await test.step('upgrade from the catalogue', async () => {
        publish(zips[1]);
        await page.goto(`web/#/dashboard/plugins/${PLUGIN_ID}?name=Yomitan`);
        // Each version in its history opens to show its changelog and its button, which says Installed for the one installed.
        await page.getByRole('button', {name: new RegExp(`^${readMeta(zips[1]).version.replaceAll('.', '\\.')} `)}).click();
        await install(page, page.getByRole('button', {name: 'Install', exact: true}));
    });

    await test.step('restart, and the new version runs with everything kept', async () => {
        await restart(page);
        await expectRunning(page, zips[1]);
        const mini = await clientFor(credentials.username, credentials.password);
        expect((await (await mini.list()).json()).dictionaries.map(({title}) => title)).toEqual(['Mini']);
        expect(await readSettings(credentials)).toEqual(settings);
    });
});
