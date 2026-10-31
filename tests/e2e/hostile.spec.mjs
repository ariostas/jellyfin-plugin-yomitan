// Dictionaries are untrusted. This imports one built to attack the page, and proves with a real popup that it cannot run
// script or reach out. Nothing in the page is a content security policy: the proof is that nothing happened.
import {createServer} from 'node:http';
import {clientFor, deleteAll, importArchive} from '../lib/dictionaries.mjs';
import {hostileStyles, hostileTitle, LIVE_ATTACKS, makeHostileDictionary, rowsPastTheSchema} from '../lib/hostile-dictionary.mjs';
import {credentials, logIn, server} from '../lib/jellyfin.mjs';
import {expectPopup, LINES, moveToWord, parkMouse, popupState, showLine, startLookupFilm} from '../lib/lookup.mjs';
import {makeMiniDictionary} from '../lib/mini-dictionary.mjs';
import {expect, test} from '../lib/test.mjs';

test.describe.configure({timeout: 120_000});

let admin;
let canary;
let canaryUrl;
const canaryHits = [];

test.beforeAll(async () => {
    canary = createServer((request, response) => {
        canaryHits.push(request.url);
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.end();
    });
    await new Promise((resolve) => {
        canary.listen(0, '127.0.0.1', resolve);
    });
    canaryUrl = `http://127.0.0.1:${canary.address().port}`;

    admin = await clientFor(credentials.username, credentials.password);
    await deleteAll(admin);
    expect((await importArchive(admin, makeMiniDictionary())).state).toBe('succeeded');
    const job = await importArchive(admin, makeHostileDictionary(canaryUrl));
    expect(job.error).toBeNull();
    expect(job.state).toBe('succeeded');
});

test.afterAll(async () => {
    await deleteAll(admin);
    await new Promise((resolve) => {
        canary.close(resolve);
    });
});

test.beforeEach(({isMobile}) => {
    test.skip(isMobile, 'The attack is on the rendering, which a mouse reaches as well as a finger.');
    canaryHits.length = 0;
});

/** jellyfin-web loads this itself on every page, for casting. */
const JELLYFIN_REQUESTS = /^https:\/\/www\.gstatic\.com\/cv\/js\/sender\//;

/** Everything the page asks for, apart from the server it came from. */
function watchRequests(page) {
    const outside = [];
    page.on('request', (request) => {
        const url = request.url();
        if (!url.startsWith(server.origin) && !/^(blob|data):/.test(url) && !JELLYFIN_REQUESTS.test(url)) {
            outside.push(url);
        }
    });
    return outside;
}

async function openWord(page, word) {
    await logIn(page);
    await startLookupFilm(page);
    await parkMouse(page);
    await showLine(page, LINES.special);
    await moveToWord(page, word);
    await expectPopup(page, word);
}

const openTrap = (page) => openWord(page, '罠');
const openLinks = (page) => openWord(page, '字幕');

const pwned = (page) => page.evaluate(() => window.pwned ?? null);

test('the canary hears a real request, so its silence below means something', async ({page}) => {
    await logIn(page);
    await page.evaluate((url) => {
        document.body.style.backgroundImage = `url("${url}/control-css.png")`;
        new Image().src = `${url}/control-image.png`;
    }, canaryUrl);
    await expect.poll(() => [...canaryHits].sort()).toEqual(['/control-css.png', '/control-image.png']);
});

test('applied as it came, the stylesheet really does reach out, so stopping it means something', async ({page}) => {
    await openTrap(page);
    expect(canaryHits).toEqual([]);
    await page.evaluate((css) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.querySelector('.yomitan-popup').shadowRoot.append(style);
    // Without the rule that hides the popup, which would leave nothing to load anything for.
    }, hostileStyles(canaryUrl).replace(/:host \{[^}]*\}/, ''));
    const heard = () => canaryHits.map((path) => path.slice(1));
    await expect.poll(() => LIVE_ATTACKS.filter((name) => !heard().includes(name))).toEqual([]);
    console.log(`the raw stylesheet made ${canaryHits.length} requests: ${[...heard()].sort().join(' ')}`);
});

test('a hostile dictionary shows as text, runs nothing and contacts nothing', async ({page}) => {
    const outside = watchRequests(page);
    await openTrap(page);

    const popup = await popupState(page);
    expect(popup.text).toContain('<script>window.pwned=\'glossary string\'</script>');
    expect(popup.text).toContain('<script>window.pwned=\'structured string\'</script>');
    expect(popup.text).toContain('onerror');

    // Give anything that was going to load the time to do it.
    await page.waitForTimeout(1500);
    expect(await pwned(page)).toBeNull();
    expect(canaryHits).toEqual([]);
    expect(outside).toEqual([]);
});

test('its stylesheet keeps what is harmless and loses all the rest', async ({page}) => {
    await openTrap(page);
    const styles = await page.evaluate(() => {
        const host = document.querySelector('.yomitan-popup');
        const [, dictionary] = host.shadowRoot.querySelectorAll('style');
        const gloss = host.shadowRoot.querySelector('.gloss-content');
        const styled = getComputedStyle(gloss);
        return {
            css: dictionary.textContent,
            color: styled.color,
            outline: styled.outlineColor,
            image: styled.backgroundImage,
            hostDisplay: getComputedStyle(host).display,
            bodyDisplay: getComputedStyle(document.body).display,
        };
    });
    expect(styles.color).toBe('rgb(1, 2, 3)');
    expect(styles.outline).toBe('rgb(4, 5, 6)');
    expect(styles.image).toBe('none');
    expect(styles.hostDisplay).toBe('block');
    expect(styles.bodyDisplay).toBe('block');
    for (const forbidden of [canaryUrl, 'url(', 'image-set(', '@font-face', '@import', '\\72']) {
        expect(styles.css).not.toContain(forbidden);
    }

    await page.waitForTimeout(800);
    expect(canaryHits).toEqual([]);
});

test('its styles stay inside the popup, and cannot cover the page', async ({page}) => {
    await openTrap(page);
    const state = await page.evaluate(() => {
        const host = document.querySelector('.yomitan-popup');
        const cover = host.shadowRoot.querySelector('[data-sc-cover]');
        const {width, height} = cover.getBoundingClientRect();
        return {
            position: getComputedStyle(cover).position,
            width,
            height,
            viewport: [innerWidth, innerHeight],
            corner: document.elementFromPoint(2, innerHeight - 2)?.className,
            title: cover.title,
            lang: cover.lang,
        };
    });
    // It may say fixed, but the popup is its containing block, and the popup clips it.
    const {box} = await popupState(page);
    expect(state.width).toBeLessThanOrEqual(box.width);
    expect(state.height).toBeLessThanOrEqual(box.height);
    expect(state.corner).not.toContain('yomitan');
    expect(state.title).toContain('<img');
});

test('an outside link does nothing until it is followed, and then opens with no way back', async ({page, context}) => {
    await openLinks(page);
    const link = page.locator('.yomitan-popup').getByText('an outside link');
    expect(await link.evaluate((element) => {
        const anchor = element.closest('a');
        return [anchor.target, anchor.rel];
    })).toEqual(['_blank', 'noreferrer noopener']);
    expect(canaryHits).toEqual([]);

    const [opened] = await Promise.all([context.waitForEvent('page'), link.click()]);
    await expect.poll(() => canaryHits).toEqual(['/link-followed']);
    await opened.waitForLoadState().catch(() => {});
    expect(await opened.evaluate(() => window.opener).catch(() => null)).toBeNull();
    await opened.close();
});

test('a link to another entry opens that entry in the popup', async ({page}) => {
    await openLinks(page);
    await page.locator('.yomitan-popup').getByText('a link to 猫').click();
    await expectPopup(page, '猫');
    expect((await popupState(page)).open).toBe(true);
});

test('an SVG only ever shows through an <img>, and its blob cannot be opened as a page', async ({page, context}) => {
    const opened = [];
    context.on('page', (newPage) => opened.push(newPage));
    await openLinks(page);
    const image = page.locator('.yomitan-popup img.gloss-image').first();
    await expect.poll(() => image.evaluate((element) => element.src)).toContain('blob:');
    const links = await page.evaluate(() => {
        const {shadowRoot} = document.querySelector('.yomitan-popup');
        return {
            withHref: shadowRoot.querySelectorAll('a.gloss-image-link[href]').length,
            all: shadowRoot.querySelectorAll('a.gloss-image-link').length,
            embedded: shadowRoot.querySelectorAll('object, embed, iframe, svg image').length,
        };
    });
    expect(links.all).toBeGreaterThan(0);
    expect(links.withHref).toBe(0);
    expect(links.embedded).toBe(0);

    await image.click({force: false});
    await page.waitForTimeout(500);
    expect(opened).toEqual([]);
    expect(await pwned(page)).toBeNull();
    expect(canaryHits).toEqual([]);
});

test('what the importer would refuse is safe in the client too', async ({page}) => {
    await page.route('**/Yomitan/Query', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        for (const {rows} of body.results) {
            for (const row of rows) {
                if (row?.term === '罠' && row.definitions) {
                    row.definitions = rowsPastTheSchema;
                }
            }
        }

        await route.fulfill({response, json: body});
    });
    const outside = watchRequests(page);
    await openTrap(page);

    const popup = page.locator('.yomitan-popup');
    for (const text of ['script link', 'data link', 'vbscript link', 'blob link', 'relative link']) {
        const link = popup.getByText(text, {exact: true});
        expect(await link.evaluate((element) => element.closest('a').hasAttribute('href')), text).toBe(false);
        await link.click();
    }

    const dom = await page.evaluate(() => {
        const {shadowRoot} = document.querySelector('.yomitan-popup');
        const entry = shadowRoot.querySelector('.entry');
        return {
            forbidden: entry.querySelectorAll('script, style, iframe').length,
            handlers: [...entry.querySelectorAll('*')].flatMap(({attributes}) => [...attributes]).filter(({name}) => name.startsWith('on')).length,
        };
    });
    expect(dom).toEqual({forbidden: 0, handlers: 0});
    await page.waitForTimeout(500);
    expect(await pwned(page)).toBeNull();
    expect(outside).toEqual([]);
    await page.unrouteAll({behavior: 'ignoreErrors'});
});

test('the title of a dictionary cannot break out of its scope', async ({page}) => {
    await openTrap(page);
    const applied = await page.evaluate((title) => {
        const {shadowRoot} = document.querySelector('.yomitan-popup');
        const item = shadowRoot.querySelector('.definition-item');
        return {matches: item.dataset.dictionary === title, sheetRules: shadowRoot.querySelectorAll('style')[1].sheet.cssRules.length};
    }, hostileTitle);
    expect(applied.matches).toBe(true);
    // One rule per dictionary with styles, whatever the title holds.
    expect(applied.sheetRules).toBe(1);
});
