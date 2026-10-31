import {expect, test} from '@playwright/test';
import {api, clientScript, logIn, rawRequest, server} from '../lib/jellyfin.mjs';

const pluginId = '5e87cc92-571a-4d8d-8d98-d2d4147f9f90';
const probe = '<meta name="file-transformation-probe" content="1">';

test.describe('with File Transformation installed', () => {
    test.skip(!server.withFileTransformation, 'Needs JF_WITH_FT=1');

    test.beforeAll(async () => {
        const plugins = await api('/Plugins');
        expect(plugins.find((plugin) => plugin.Id.replaceAll('-', '') === pluginId.replaceAll('-', ''))?.Status)
            .toBe('Active');

        await api(`/Plugins/${pluginId}/Configuration`, {
            method: 'POST',
            body: {
                Transformations: [{
                    Id: 'c1a4ee6a-7b45-4f0d-9a55-3d6bbf0e6f11',
                    FilenamePattern: 'index\\.html$',
                    SearchText: '</title>',
                    ReplaceText: `</title>${probe}`,
                }],
            },
        });
    });

    test('its edit and our tag are both served, once each', async () => {
        for (const headers of [{}, {'Accept-Encoding': 'gzip, br'}]) {
            const {status, text, headers: responseHeaders, body} = await rawRequest('/web/', {headers});
            expect(status).toBe(200);
            expect(responseHeaders['content-encoding']).toBeUndefined();
            expect(Number(responseHeaders['content-length'])).toBe(body.length);
            expect(text.split(probe).length - 1).toBe(1);
            expect(text.split('data-yomitan-client').length - 1).toBe(1);
        }
    });

    test('the middleware order is the one this run set out to test', async () => {
        // Each middleware overwrites the ETag, so the outermost one is visible. The order matters: only with
        // File Transformation inside us does this prove that we keep what the pipeline produced.
        const {headers} = await rawRequest('/web/');
        const position = headers.etag.startsWith('"yomitan-') ? 'inner' : 'outer';
        expect(position).toBe(process.env.JF_FT_ORDER ?? 'outer');
    });

    test('revalidation ends in a 304', async () => {
        const {headers} = await rawRequest('/web/');
        const {status} = await rawRequest('/web/', {headers: {'If-None-Match': headers.etag}});
        expect(status).toBe(304);
    });

    test('the browser ends up with both', async ({page}) => {
        await logIn(page);
        expect(await page.evaluate(() => window.__yomitanJellyfin)).toBeTruthy();
        await expect(page.locator(clientScript)).toHaveCount(1);
        await expect(page.locator('meta[name="file-transformation-probe"]')).toHaveCount(1);
    });
});
