// A user's own settings page, as a real non-admin reaches and uses it. The android-chrome project runs this at a phone's
// size, with touch.
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {createUser, credentials, deleteUser, getMovies, logIn, play, readSettings, saveSettings} from '../lib/jellyfin.mjs';
import {useTvLayout} from '../lib/keys.mjs';
import {makeMiniDictionary} from '../lib/mini-dictionary.mjs';
import {LINES, showLine, startLookupFilm} from '../lib/lookup.mjs';
import {expect, test} from '../lib/test.mjs';
import {makeDictionary} from '../lib/zip.mjs';

test.describe.configure({timeout: 120_000});

const HOSTILE_TITLE = '<img src=x onerror="window.attacked=1"><script>window.attacked=2</script>';
const smallDictionary = (title) => makeDictionary({title, format: 3, revision: '1', sequenced: true}, {'term_bank_1.json': [['猫', 'ねこ', '', '', 0, ['cat'], 1, '']]});

let admin;
let user;
let movies;

test.beforeAll(async () => {
    admin = await clientFor(credentials.username, credentials.password);
    await deleteAll(admin);
    expect((await importArchive(admin, makeMiniDictionary())).state).toBe('succeeded');
    user = await createUser('dana');
    movies = await getMovies();
});

test.afterAll(async () => {
    await deleteUser(user);
    await deleteAll(admin);
});

const click = (locator, isMobile) => (isMobile ? locator.tap() : locator.click());

/** The way a person gets there: the picture in the header, Settings in its menu, then the link. */
async function openFromHome(page, isMobile) {
    await click(page.getByRole('button', {name: 'User Menu'}), isMobile);
    await click(page.getByRole('menuitem', {name: 'Settings'}), isMobile);
    await page.waitForURL(/mypreferencesmenu/);
    await click(page.locator('.yomitan-settings-link'), isMobile);
    await page.locator('.yomitan-settings').waitFor();
}

const titles = (page) => page.locator('.yomitan-dictionary-title').allTextContents();

test('a non-admin finds it behind their picture, uses it, and Back goes back', async ({page, isMobile}) => {
    await logIn(page, {user, settings: {enabled: false}});
    await openFromHome(page, isMobile);
    const enabled = page.locator('#yomitan-setting-enabled');
    await expect(enabled).not.toBeChecked();
    await click(enabled, isMobile);
    await expect(enabled).toBeChecked();
    await expect(page.locator('.yomitan-status')).toHaveText('Saved');
    await expect.poll(async () => (await readSettings(user)).enabled).toBe(true);

    await page.goBack();
    await expect(page.locator('.yomitan-settings')).toHaveCount(0);
    await expect(page.locator('.yomitan-settings-link')).toBeVisible();
    expect(page.url()).toContain('mypreferencesmenu');

    await page.reload();
    await click(page.locator('.yomitan-settings-link'), isMobile);
    await expect(page.locator('#yomitan-setting-enabled')).toBeChecked();
    await click(page.locator('.yomitan-settings-close'), isMobile);
    await expect(page.locator('.yomitan-settings')).toHaveCount(0);
});

test('every control fits, can be hit, and nothing scrolls sideways', async ({page, isMobile}) => {
    await importArchive(admin, smallDictionary('A title much too long for the width of any phone '.repeat(4)));
    await importArchive(admin, smallDictionary('A'.repeat(300)));
    await logIn(page, {user});
    await openFromHome(page, isMobile);
    await expect(page.locator('.yomitan-dictionary')).toHaveCount(3);
    const fit = await page.evaluate(() => {
        const panel = document.querySelector('.yomitan-settings');
        const small = [...panel.querySelectorAll('button, input[type=number], label.yomitan-check')].filter((node) => {
            const {width, height} = node.getBoundingClientRect();
            return width < 44 || height < 44;
        }).map((node) => node.outerHTML.slice(0, 80));
        const outside = [...panel.querySelectorAll('*')].filter((node) => node.getBoundingClientRect().right > innerWidth + 0.5).map((node) => node.outerHTML.slice(0, 80));
        return {sideways: panel.scrollWidth - panel.clientWidth, small, outside};
    });
    expect(fit).toEqual({sideways: 0, small: [], outside: []});
    for (const dictionary of await admin.list().then((response) => response.json()).then(({dictionaries}) => dictionaries)) {
        if (dictionary.title !== 'Mini') {
            await admin.remove(dictionary.title);
        }
    }

    await expect.poll(async () => (await (await admin.list()).json()).dictionaries.length).toBe(1);
});

test('the settings page takes effect in playback', async ({page, isMobile}) => {
    await logIn(page, {user});
    await startLookupFilm(page);
    await showLine(page, LINES.plain);
    const size = () => page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector('.yomitan-overlay')).fontSize));
    const normal = await size();
    await page.evaluate(() => window.__yomitanJellyfin.settings.set('fontScale', 200));
    await expect.poll(size).toBeCloseTo(normal * 2);
    await expect.poll(async () => (await readSettings(user)).fontScale).toBe(200);

    await page.evaluate(() => window.__yomitanJellyfin.playbackManager.stop());
    await page.goto('web/#/mypreferencesmenu');
    await click(page.locator('.yomitan-settings-link'), isMobile);
    const slider = page.locator('#yomitan-setting-fontScale');
    await expect(slider).toHaveValue('200');
    await slider.evaluate((input) => {
        input.value = 150;
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
    });
    await expect(page.locator('.yomitan-settings output')).toHaveText('150%');
    await expect.poll(async () => (await readSettings(user)).fontScale).toBe(150);
    await click(page.locator('.yomitan-settings-close'), isMobile);
    await play(page, movies.LookupSample, {subtitleStreamIndex: 0, minimumTime: 0.5});
    await page.waitForFunction(() => window.__yomitanJellyfin.playback.session?.state === 'active');
    await showLine(page, LINES.plain);
    await expect.poll(size).toBeCloseTo(normal * 1.5);
});

test('numbers stay in bounds, and the remote setting saves', async ({page, isMobile}) => {
    await logIn(page, {user});
    await openFromHome(page, isMobile);
    const delay = page.locator('#yomitan-setting-hoverDelayMs');
    await delay.fill('999999');
    await delay.blur();
    await expect(delay).toHaveValue('5000');
    await expect.poll(async () => (await readSettings(user)).hoverDelayMs).toBe(5000);
    await delay.fill('');
    await delay.blur();
    await expect(delay).toHaveValue('5000');
    await delay.fill('350');
    await delay.blur();
    await expect.poll(async () => (await readSettings(user)).hoverDelayMs).toBe(350);

    const upOnly = page.locator('#yomitan-setting-upOnlyEntry');
    await click(upOnly, isMobile);
    await expect.poll(async () => (await readSettings(user)).upOnlyEntry).toBe(true);
});

test.describe('the list of dictionaries', () => {
    test.beforeEach(async () => {
        await deleteAll(admin);
        for (const title of ['One', 'Two', 'Three']) {
            await importArchive(admin, smallDictionary(title));
        }
    });

    test.afterEach(async () => {
        await deleteAll(admin);
        await importArchive(admin, makeMiniDictionary());
    });

    test('it orders, turns off, and shows it again next time', async ({page, isMobile}) => {
        await logIn(page, {user});
        await openFromHome(page, isMobile);
        await expect.poll(() => titles(page)).toEqual(['One', 'Two', 'Three']);
        await click(page.getByRole('button', {name: 'Move Three up'}), isMobile);
        await expect.poll(() => titles(page)).toEqual(['One', 'Three', 'Two']);
        await click(page.getByRole('button', {name: 'Move One down'}), isMobile);
        await expect.poll(() => titles(page)).toEqual(['Three', 'One', 'Two']);
        await click(page.getByRole('checkbox', {name: 'Use Two'}), isMobile);
        await expect.poll(() => readSettings(user)).toMatchObject({dictionaryOrder: ['Three', 'One', 'Two'], disabledDictionaries: ['Two']});

        await page.reload();
        await click(page.locator('.yomitan-settings-link'), isMobile);
        await expect.poll(() => titles(page)).toEqual(['Three', 'One', 'Two']);
        await expect(page.getByRole('checkbox', {name: 'Use Two'})).not.toBeChecked();
        await expect(page.getByRole('button', {name: 'Move Three up'})).toBeDisabled();
        await expect(page.getByRole('button', {name: 'Move Two down'})).toBeDisabled();
    });

    test('one added later is on and last, and one deleted is gone without a word', async ({page, isMobile}) => {
        await logIn(page, {user, settings: {enabled: true, dictionaryOrder: ['Three', 'One', 'Two', 'Deleted long ago'], disabledDictionaries: ['Two', 'Deleted long ago']}});
        await importArchive(admin, smallDictionary('Four'));
        await admin.remove('One');
        await expect.poll(async () => (await (await admin.list()).json()).dictionaries.length).toBe(3);

        await openFromHome(page, isMobile);
        await expect.poll(() => titles(page)).toEqual(['Three', 'Two', 'Four']);
        await expect(page.getByRole('checkbox', {name: 'Use Four'})).toBeChecked();
        await expect(page.getByRole('checkbox', {name: 'Use Two'})).not.toBeChecked();

        // Saving from here keeps what is there, and drops the titles that are gone.
        await click(page.getByRole('checkbox', {name: 'Use Three'}), isMobile);
        await expect.poll(async () => (await readSettings(user)).disabledDictionaries).toEqual(['Two', 'Three']);
    });

    test('a hostile title is text, here as well', async ({page, isMobile}) => {
        await importArchive(admin, smallDictionary(HOSTILE_TITLE));
        await logIn(page, {user});
        await openFromHome(page, isMobile);
        await expect.poll(() => titles(page)).toContain(HOSTILE_TITLE);
        await click(page.getByRole('checkbox', {name: `Use ${HOSTILE_TITLE}`}), isMobile);
        await expect.poll(async () => (await readSettings(user)).disabledDictionaries).toEqual([HOSTILE_TITLE]);
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => window.attacked)).toBeUndefined();
        expect(await page.locator('.yomitan-settings img, .yomitan-settings script').count()).toBe(0);
    });

    test('with nothing installed it says so', async ({page, isMobile}) => {
        await deleteAll(admin);
        await logIn(page, {user});
        await openFromHome(page, isMobile);
        await expect(page.locator('.yomitan-settings')).toContainText('No dictionaries are installed');
    });

    test('a list that cannot load says so, and keeps the choices', async ({page, isMobile}) => {
        await logIn(page, {user, settings: {disabledDictionaries: ['Two']}});
        await page.route('**/Yomitan/Dictionaries', (route) => route.abort());
        await openFromHome(page, isMobile);
        await expect(page.locator('.yomitan-settings')).toContainText('could not be listed');
        expect((await readSettings(user)).disabledDictionaries).toEqual(['Two']);
    });
});

test('a save that fails is shown on the page, and goes out when it can', async ({page, isMobile}) => {
    await logIn(page, {user, settings: {enabled: false}});
    await openFromHome(page, isMobile);
    await page.route('**/Yomitan/Settings', (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue()));
    await click(page.locator('#yomitan-setting-enabled'), isMobile);
    await expect(page.locator('.yomitan-status')).toContainText('Not saved yet');
    await page.unroute('**/Yomitan/Settings');
    await expect(page.locator('.yomitan-status')).toHaveText('Saved', {timeout: 15_000});
    expect((await readSettings(user)).enabled).toBe(true);
});

test('a change from another device shows on the open page', async ({page, isMobile}) => {
    await logIn(page, {user, settings: {fontScale: 100}});
    await openFromHome(page, isMobile);
    await saveSettings(user, {fontScale: 170});
    await page.evaluate(() => window.__yomitanJellyfin.settings.refresh({force: true}));
    await expect(page.locator('#yomitan-setting-fontScale')).toHaveValue('170');
});

test('an admin looking at someone else\'s preferences gets no link, since this page is always one\'s own', async ({page}) => {
    await logIn(page);
    await page.goto(`web/#/mypreferencesmenu?userId=${user.id}`);
    await page.locator('.lnkSubtitlePreferences').waitFor();
    await page.waitForTimeout(500);
    await expect(page.locator('.yomitan-settings-link')).toHaveCount(0);
});

test('a page in its old layout: no link and no error when the place for it is gone', async ({page}) => {
    await page.addInitScript(() => {
        const {querySelector} = Document.prototype;
        Document.prototype.querySelector = function (selector) {
            return selector.includes('lnkSubtitlePreferences') ? null : querySelector.call(this, selector);
        };
    });
    await logIn(page, {user});
    await page.goto('web/#/mypreferencesmenu');
    await page.locator('.lnkDisplayPreferences').waitFor();
    await page.waitForTimeout(500);
    await expect(page.locator('.yomitan-settings-link')).toHaveCount(0);
});

test('a remote can walk it', async ({page, isMobile}) => {
    test.skip(isMobile, 'A phone has no keys.');
    await useTvLayout(page);
    await logIn(page, {user});
    await page.goto('web/#/mypreferencesmenu');
    await page.locator('.yomitan-settings-link').focus();
    await page.keyboard.press('Enter');
    await page.locator('.yomitan-settings').waitFor();
    await expect(page.locator('#yomitan-setting-enabled')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.yomitan-dictionary') !== null || document.activeElement?.id)).toBeTruthy();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#yomitan-setting-enabled')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await readSettings(user)).enabled).toBe(false);

    await page.keyboard.press('Escape');
    await expect(page.locator('.yomitan-settings')).toHaveCount(0);
    await expect(page.locator('.yomitan-settings-link')).toBeFocused();
    expect(page.url()).toContain('mypreferencesmenu');
});
