// How settings move between the server, this browser and the page: nothing waits on the network, nothing is lost, and
// nothing crosses from one user to another. The server's side is in settings-api.spec.mjs.
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {createUser, credentials, deleteUser, fillLogin, getMovies, logIn, play, readSettings, saveSettings, server, signOut} from '../lib/jellyfin.mjs';
import {expectPopup, LINES, moveToWord, parkMouse, showLine, startLookupFilm} from '../lib/lookup.mjs';
import {makeMiniDictionary} from '../lib/mini-dictionary.mjs';
import {jellyfinLine, overlayText} from '../lib/player.mjs';
import {expect, test} from '../lib/test.mjs';

test.describe.configure({timeout: 120_000});

const SETTINGS = '**/Yomitan/Settings';

let admin;
let alice;
let bob;
let movies;

test.beforeAll(async () => {
    admin = await clientFor(credentials.username, credentials.password);
    await deleteAll(admin);
    expect((await importArchive(admin, makeMiniDictionary())).state).toBe('succeeded');
    movies = await getMovies();
    alice = await createUser('alice');
    bob = await createUser('bob');
});

test.afterAll(async () => {
    await deleteUser(alice);
    await deleteUser(bob);
    await deleteAll(admin);
});

const store = (page) => page.evaluate(() => {
    const {settings} = window.__yomitanJellyfin;
    return {user: settings.userId, enabled: settings.get('enabled'), delay: settings.get('hoverDelayMs'), sync: settings.syncState};
});

const engineRequests = (page) => {
    const urls = [];
    page.on('request', (request) => {
        if (request.url().includes('/Yomitan/engine.js')) {
            urls.push(request.url());
        }
    });
    return urls;
};

const signedIn = (page, user) => page.waitForFunction((id) => window.__yomitanJellyfin.settings.userId === id, user.id);

test.describe('a user who has never touched anything', () => {
    test('sees playback exactly as it is without the plugin', async ({page}) => {
        const user = await createUser('new');
        const engine = engineRequests(page);
        await logIn(page, {user, settings: null});
        await signedIn(page, user);
        await play(page, movies.LookupSample, {subtitleStreamIndex: 0, minimumTime: 1.5});
        await expect.poll(() => page.evaluate(() => {
            const inner = document.querySelector('.videoSubtitlesInner');
            const cue = document.querySelector('video.htmlvideoplayer').textTracks[0]?.activeCues?.[0];
            return inner?.textContent ?? cue?.text ?? '';
        })).toContain('昨日');
        expect(await jellyfinLine(page)).toBe('showing');
        expect(await page.locator('.yomitan-overlay').count()).toBe(0);
        expect(await page.evaluate(() => document.documentElement.hasAttribute('data-yomitan-hides-subtitles'))).toBe(false);
        expect(engine).toEqual([]);
        expect(await page.evaluate(() => window.__yomitanJellyfin.playback)).toBeUndefined();
        await deleteUser(user);
    });
});

test.describe('the network never holds anything up', () => {
    test('with the server silent about settings, a video still plays, and a new user stays off', async ({page}) => {
        const engine = engineRequests(page);
        const hanging = [];
        await page.route(SETTINGS, (route) => {
            hanging.push(route);
        });
        await logIn(page, {user: alice, settings: {enabled: true}});
        await signedIn(page, alice);
        await play(page, movies.LookupSample, {subtitleStreamIndex: 0, minimumTime: 1});
        expect(hanging.length).toBeGreaterThan(0);
        expect(await store(page)).toMatchObject({enabled: false, user: alice.id});
        expect(engine).toEqual([]);
        await page.unroute(SETTINGS);
    });

    test('with the server silent, the last settings seen here take effect at once', async ({page}) => {
        await logIn(page, {user: alice, settings: {enabled: true, hoverDelayMs: 321}});
        await expect.poll(() => store(page)).toMatchObject({enabled: true, delay: 321});

        await page.route(SETTINGS, () => {});
        await page.reload();
        await signedIn(page, alice);
        expect(await store(page)).toMatchObject({enabled: true, delay: 321});
        // Well under the 15 s a silent request takes to time out, so nothing was waiting for it.
        const started = Date.now();
        await startLookupFilm(page);
        expect(Date.now() - started).toBeLessThan(12_000);
        await page.unroute(SETTINGS);
    });

    test('a broken answer or broken cache leaves the defaults or the cache, and the page alive', async ({page}) => {
        await logIn(page, {user: alice, settings: {enabled: true}});
        await expect.poll(() => store(page)).toMatchObject({enabled: true});
        await page.route(SETTINGS, (route) => route.abort());
        await page.reload();
        await signedIn(page, alice);
        expect((await store(page)).enabled).toBe(true);

        await page.evaluate((id) => localStorage.setItem(`yomitan.settings.${id}`, '{not json'), alice.id);
        await page.reload();
        await signedIn(page, alice);
        expect((await store(page)).enabled).toBe(false);

        await page.evaluate((id) => localStorage.setItem(`yomitan.settings.${id}`, JSON.stringify({values: {enabled: 'yes', hoverDelayMs: null, hoverGraceMs: 900}})), alice.id);
        await page.reload();
        await signedIn(page, alice);
        expect(await page.evaluate(() => {
            const {settings} = window.__yomitanJellyfin;
            return [settings.get('enabled'), settings.get('hoverDelayMs'), settings.get('hoverGraceMs')];
        })).toEqual([false, 200, 900]);
        await page.unroute(SETTINGS);
    });
});

test.describe('a change on another device', () => {
    test('arrives with the next playback, in a page already open', async ({page}) => {
        await logIn(page, {user: alice, settings: {enabled: false}});
        await signedIn(page, alice);
        await expect.poll(() => store(page)).toMatchObject({enabled: false});
        await saveSettings(alice, {enabled: true});
        expect((await store(page)).enabled).toBe(false);
        await startLookupFilm(page);
    });

    test('turning it off elsewhere takes the overlay down at the next start, whatever the cache says', async ({page}) => {
        await logIn(page, {user: alice, settings: {enabled: true}});
        await startLookupFilm(page);
        await showLine(page, LINES.plain);
        await page.evaluate(() => window.__yomitanJellyfin.playback.playbackManager.stop());
        await page.waitForFunction(() => !window.__yomitanJellyfin.playback.session);
        await saveSettings(alice, {enabled: false});
        await play(page, movies.LookupSample, {subtitleStreamIndex: 0, minimumTime: 1});
        await expect.poll(() => page.locator('.yomitan-overlay').count()).toBe(0);
        expect(await jellyfinLine(page)).toBe('showing');
    });

    test('arrives sooner when someone comes back to the tab', async ({page}) => {
        test.setTimeout(90_000);
        await logIn(page, {user: alice, settings: {enabled: false, hoverDelayMs: 200}});
        await expect.poll(() => store(page)).toMatchObject({delay: 200});
        await saveSettings(alice, {hoverDelayMs: 640});
        // A refresh is limited to one in 30 s, and that clock started when the user was first seen.
        await page.waitForTimeout(31_000);
        expect((await store(page)).delay).toBe(200);
        await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
        await expect.poll(() => store(page)).toMatchObject({delay: 640});
    });
});

test.describe('a write that fails', () => {
    test('is shown, is sent again, and arrives without anyone doing anything', async ({page}) => {
        await logIn(page, {user: alice, settings: {enabled: false, hoverDelayMs: 200}});
        await signedIn(page, alice);
        let attempts = 0;
        await page.route(SETTINGS, (route) => {
            if (route.request().method() !== 'PUT') {
                return route.continue();
            }

            attempts += 1;
            return attempts < 3 ? route.abort() : route.continue();
        });

        await page.evaluate(() => window.__yomitanJellyfin.settings.set('hoverDelayMs', 555));
        // It holds here at once, and nothing pretends that it was saved.
        expect((await store(page)).delay).toBe(555);
        await expect(page.locator('.yomitan-notice')).toContainText('has not reached the server');
        expect((await store(page)).sync).toBe('retrying');
        expect((await readSettings(alice)).hoverDelayMs).toBe(200);

        await expect.poll(async () => (await readSettings(alice)).hoverDelayMs, {timeout: 20_000}).toBe(555);
        expect(attempts).toBe(3);
        await expect.poll(() => store(page)).toMatchObject({sync: 'saved'});
        await page.unroute(SETTINGS);
    });

    test('a 500 is sent again too, and a reload does not lose it', async ({page}) => {
        await logIn(page, {user: alice, settings: {hoverGraceMs: 300}});
        await signedIn(page, alice);
        await page.route(SETTINGS, (route) => (route.request().method() === 'PUT' ? route.fulfill({status: 500, body: 'no'}) : route.continue()));
        await page.evaluate(() => window.__yomitanJellyfin.settings.set('hoverGraceMs', 777));
        await expect.poll(() => store(page)).toMatchObject({sync: 'retrying'});

        await page.unroute(SETTINGS);
        await page.reload();
        await signedIn(page, alice);
        await expect.poll(async () => (await readSettings(alice)).hoverGraceMs).toBe(777);
        expect(await page.evaluate(() => window.__yomitanJellyfin.settings.get('hoverGraceMs'))).toBe(777);
    });

    test('a value the server refuses goes back, says so, and is not sent again', async ({page}) => {
        await logIn(page, {user: alice, settings: {hoverDelayMs: 200}});
        await signedIn(page, alice);
        let writes = 0;
        page.on('request', (request) => {
            writes += request.url().endsWith('/Yomitan/Settings') && request.method() === 'PUT' ? 1 : 0;
        });
        await page.evaluate(() => window.__yomitanJellyfin.settings.set('hoverDelayMs', 999_999));
        await expect(page.locator('.yomitan-notice')).toContainText('refused');
        await expect.poll(() => store(page)).toMatchObject({delay: 200, sync: 'refused'});
        await page.waitForTimeout(2500);
        expect(writes).toBe(1);
    });

    test('a change made during a write is not lost when the write comes back', async ({page}) => {
        await logIn(page, {user: alice, settings: {hoverDelayMs: 200, hoverGraceMs: 300}});
        await signedIn(page, alice);
        let release;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        await page.route(SETTINGS, async (route) => {
            if (route.request().method() === 'PUT' && route.request().postData().includes('410')) {
                await held;
            }

            await route.continue();
        });
        await page.evaluate(() => window.__yomitanJellyfin.settings.set('hoverDelayMs', 410));
        await page.waitForTimeout(600);
        await page.evaluate(() => window.__yomitanJellyfin.settings.set('hoverDelayMs', 420));
        await page.evaluate(() => window.__yomitanJellyfin.settings.set('hoverGraceMs', 430));
        release();
        await expect.poll(() => readSettings(alice)).toMatchObject({hoverDelayMs: 420, hoverGraceMs: 430});
        expect((await store(page)).delay).toBe(420);
        await page.unroute(SETTINGS);
    });
});

test.describe('two users on one browser', () => {
    test('one user\'s settings never reach the other, even with the server silent', async ({page}) => {
        await logIn(page, {user: alice, settings: {enabled: true, hoverDelayMs: 901}});
        await expect.poll(() => store(page)).toMatchObject({enabled: true, delay: 901, user: alice.id});
        await startLookupFilm(page);
        await showLine(page, LINES.plain);
        await page.evaluate(() => window.__yomitanJellyfin.playback.playbackManager.stop());

        await page.route(SETTINGS, () => {});
        await signOut(page);
        await expect.poll(() => store(page)).toMatchObject({enabled: false, delay: 200, user: null});
        await fillLogin(page, bob);
        await signedIn(page, bob);
        expect(await store(page)).toMatchObject({enabled: false, delay: 200, user: bob.id});

        await play(page, movies.LookupSample, {subtitleStreamIndex: 0, minimumTime: 1});
        expect(await page.locator('.yomitan-overlay').count()).toBe(0);
        expect(await jellyfinLine(page)).toBe('showing');
        await page.unroute(SETTINGS);
    });

    test('each keeps their own cache, and gets it back', async ({page}) => {
        await saveSettings(bob, {hoverDelayMs: 202});
        await logIn(page, {user: alice, settings: {hoverDelayMs: 101}});
        await expect.poll(() => store(page)).toMatchObject({delay: 101});
        await signOut(page);
        await fillLogin(page, bob);
        await expect.poll(() => store(page)).toMatchObject({delay: 202, user: bob.id});

        const keys = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('yomitan.settings')).sort());
        expect(keys).toEqual([`yomitan.settings.${alice.id}`, `yomitan.settings.${bob.id}`].sort());

        await page.route(SETTINGS, () => {});
        await signOut(page);
        await fillLogin(page, alice);
        await signedIn(page, alice);
        expect((await store(page)).delay).toBe(101);
        await page.unroute(SETTINGS);
    });

    test('a write that is waiting goes out under its own user, or not at all', async ({page}) => {
        await saveSettings(bob, {hoverDelayMs: 200});
        await logIn(page, {user: alice, settings: {hoverDelayMs: 200}});
        await signedIn(page, alice);
        const failing = (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue());
        await page.route(SETTINGS, failing);
        await page.evaluate(() => window.__yomitanJellyfin.settings.set('hoverDelayMs', 666));
        await expect.poll(() => store(page)).toMatchObject({sync: 'retrying'});

        await signOut(page);
        await fillLogin(page, bob);
        await signedIn(page, bob);
        await page.unroute(SETTINGS, failing);
        // Past the first two retries, which run on a timer that started under Alice.
        await page.waitForTimeout(8000);
        expect((await readSettings(bob)).hoverDelayMs).toBe(200);
        expect((await readSettings(alice)).hoverDelayMs).toBe(200);
        expect((await store(page)).delay).toBe(200);

        await signOut(page);
        await fillLogin(page, alice);
        await expect.poll(async () => (await readSettings(alice)).hoverDelayMs).toBe(666);
        expect((await readSettings(bob)).hoverDelayMs).toBe(200);
    });

    test('a write due as the user changes, before the store has heard, stays where it is', async ({page}) => {
        await logIn(page, {user: alice, settings: {hoverDelayMs: 200}});
        await signedIn(page, alice);
        const failing = (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue());
        await page.route(SETTINGS, failing);
        await page.evaluate(() => window.__yomitanJellyfin.settings.set('hoverDelayMs', 777));
        await expect.poll(() => store(page)).toMatchObject({sync: 'retrying'});

        // Someone else's token, with no page shown yet to tell the store. The server would file this under them.
        await page.unroute(SETTINGS, failing);
        await page.evaluate((id) => {
            window.ApiClient.getCurrentUserId = () => id;
        }, bob.id);
        let writes = 0;
        page.on('request', (request) => {
            writes += request.url().endsWith('/Yomitan/Settings') && request.method() === 'PUT' ? 1 : 0;
        });
        await page.waitForTimeout(6000);
        expect(writes).toBe(0);
        expect(await page.evaluate((id) => JSON.parse(localStorage.getItem(`yomitan.settings.${id}`)).pending, alice.id)).toEqual({hoverDelayMs: 777});

        await page.reload();
        await expect.poll(async () => (await readSettings(alice)).hoverDelayMs).toBe(777);
    });

    test('an answer for one user that lands after they left is dropped', async ({page}) => {
        // A new user, so that their revision is lower than Alice's, and only the user tells the answer apart.
        const carol = await createUser('carol');
        await saveSettings(carol, {hoverDelayMs: 333, enabled: false});
        await page.goto('web/');
        let release;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        let first = true;
        await page.route(SETTINGS, async (route) => {
            if (first) {
                first = false;
                await held;
                // By now Alice's token has ended, so the server would refuse it. This is the answer from before that.
                await route.fulfill({json: {revision: 9999, settings: {hoverDelayMs: 811, enabled: true}}});
                return;
            }

            await route.continue();
        });
        await fillLogin(page, alice);
        await signedIn(page, alice);
        await signOut(page);
        await fillLogin(page, carol);
        // Her own answer does not wait behind the one still out for Alice.
        await expect.poll(() => store(page)).toMatchObject({user: carol.id, delay: 333});
        release();
        await page.waitForTimeout(500);
        expect(await store(page)).toMatchObject({user: carol.id, delay: 333, enabled: false});
        await page.unroute(SETTINGS);
        await deleteUser(carol);
    });
});

test('the exit check of PLAN.md: a non-admin changes a setting in one browser, and the other shows it in playback', {tag: '@smoke'}, async ({browser, browserName}) => {
    test.skip(browserName !== 'chromium', 'Two contexts say the same in every browser.');
    const open = async () => {
        const context = await browser.newContext({baseURL: `${server.url}/`, viewport: {width: 1280, height: 720}});
        const page = await context.newPage();
        return {context, page};
    };

    const user = await createUser('carol');
    const phone = await open();
    const laptop = await open();
    await logIn(phone.page, {user, settings: null});
    await signedIn(phone.page, user);
    await logIn(laptop.page, {user, settings: null});
    await signedIn(laptop.page, user);

    // On the first device, through the real settings page.
    await phone.page.goto('web/#/mypreferencesmenu');
    await phone.page.locator('.yomitan-settings-link').click();
    await phone.page.locator('#yomitan-setting-enabled').check();
    const delay = phone.page.locator('#yomitan-setting-hoverDelayMs');
    await delay.fill('900');
    await delay.blur();
    await expect(phone.page.locator('.yomitan-status')).toHaveText('Saved');

    // On the second, which has held the old settings all along, what changes is what the video does.
    await expect.poll(() => laptop.page.evaluate(() => window.__yomitanJellyfin.settings.get('enabled'))).toBe(false);
    await startLookupFilm(laptop.page);
    await showLine(laptop.page, LINES.plain);
    expect(await overlayText(laptop.page)).toContain('昨日');
    await parkMouse(laptop.page);
    await moveToWord(laptop.page, '学校');
    await laptop.page.waitForTimeout(500);
    expect(await laptop.page.locator('.yomitan-popup:not([hidden])').count()).toBe(0);
    await expectPopup(laptop.page, '学校');

    await phone.context.close();
    await laptop.context.close();
    await deleteUser(user);
});
