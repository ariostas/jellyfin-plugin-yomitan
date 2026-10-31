import {clientScript, getMovies, logIn, play, server} from '../lib/jellyfin.mjs';
import {expect, test} from '../lib/test.mjs';

test('the client script runs in jellyfin-web and stays single across reloads', async ({page}) => {
    const scriptResponses = [];
    const errors = [];
    page.on('response', (response) => {
        if (response.url().includes('/Yomitan/client.js')) {
            scriptResponses.push(response);
        }
    });
    page.on('pageerror', (error) => errors.push(error.message));

    await logIn(page);

    const marker = await page.evaluate(() => window.__yomitanJellyfin);
    expect(marker).toMatchObject({version: expect.any(String)});
    expect(scriptResponses.length).toBe(1);
    expect(scriptResponses[0].status()).toBe(200);
    expect(new URL(scriptResponses[0].url()).pathname).toBe(`${server.prefix}/Yomitan/client.js`);
    await expect(page.locator(clientScript)).toHaveCount(1);

    for (let reload = 0; reload < 3; reload += 1) {
        await page.reload();
        await page.waitForFunction(() => window.ApiClient?.isLoggedIn());
        await expect(page.locator(clientScript)).toHaveCount(1);
        expect(await page.evaluate(() => window.__yomitanJellyfin.version)).toEqual(marker.version);
    }

    expect(errors).toEqual([]);
});

test('the client is present before login, on the login page', async ({page}) => {
    await page.goto('web/');
    await page.locator('#txtManualName, .btnManual').first().waitFor();
    expect(await page.evaluate(() => window.__yomitanJellyfin)).toBeTruthy();
    expect(await page.evaluate(() => window.ApiClient.isLoggedIn())).toBe(false);
});

test('a movie plays with the client loaded', async ({page}) => {
    await logIn(page);
    const movies = await getMovies();
    expect(Object.keys(movies).sort()).toEqual(['AssSample', 'ImageSample', 'LookupSample', 'SrtSample', 'TracksSample', 'TranscodeSample', 'TypesetSample']);

    await play(page, movies.SrtSample);
    expect(await page.evaluate(() => window.__yomitanJellyfin)).toBeTruthy();
});
