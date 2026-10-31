import {expect, test} from '@playwright/test';
import {rawRequest, server} from '../lib/jellyfin.mjs';

const tagPattern = /<script defer data-yomitan-client src="([^"]+)"><\/script>/g;

function tags(html) {
    return [...html.matchAll(tagPattern)];
}

for (const path of ['/web/', '/web/index.html']) {
    test(`GET ${path} has one tag, correctly placed and pointing at the script`, async () => {
        const {status, headers, text} = await rawRequest(path);
        expect(status).toBe(200);
        expect(headers['content-type']).toContain('text/html');

        const found = tags(text);
        expect(found.length).toBe(1);
        expect(text.indexOf(found[0][0])).toBeLessThan(text.lastIndexOf('</body>'));

        const script = new URL(found[0][1], `${server.url}${path}`);
        expect(script.pathname).toBe(`${server.prefix}/Yomitan/client.js`);
        const {status: scriptStatus} = await rawRequest(`/Yomitan/client.js${script.search}`);
        expect(scriptStatus).toBe(200);
    });
}

test('a client that accepts compression still gets the tag, with an honest Content-Length', async () => {
    const {headers, body, text} = await rawRequest('/web/', {headers: {'Accept-Encoding': 'gzip, deflate, br'}});
    expect(headers['content-encoding']).toBeUndefined();
    expect(Number(headers['content-length'])).toBe(body.length);
    expect(tags(text).length).toBe(1);
});

test('HEAD is not touched, and GET grows by exactly the tag', async () => {
    // File Transformation answers HEAD itself, with a Content-Length of 0.
    test.skip(server.withFileTransformation, 'Needs the stock HEAD response');

    const head = await rawRequest('/web/', {method: 'HEAD'});
    const get = await rawRequest('/web/');
    const [[tag]] = tags(get.text);
    expect(Number(head.headers['content-length'])).toBe(get.body.length - Buffer.byteLength(tag));
    expect(head.headers.etag).not.toBe(get.headers.etag);
});

test('other responses are not touched', async () => {
    const {text} = await rawRequest('/web/');
    const bundle = /src="(main\.jellyfin\.bundle\.js[^"]*)"/.exec(text)[1];

    const script = await rawRequest(`/web/${bundle}`);
    expect(script.status).toBe(200);
    expect(script.text).not.toContain('data-yomitan-client');

    const missing = await rawRequest('/web/does-not-exist.html');
    expect(missing.status).toBe(404);

    const info = await rawRequest('/System/Info/Public');
    expect(info.text).not.toContain('data-yomitan-client');
});

test('revalidation works and cannot pin a copy from before the plugin was installed', async () => {
    const {headers} = await rawRequest('/web/');
    expect(headers['cache-control']).toBe('no-cache');

    const current = await rawRequest('/web/', {headers: {'If-None-Match': headers.etag}});
    expect(current.status).toBe(304);
    expect(current.body.length).toBe(0);
    expect(current.headers.etag).toBe(headers.etag);

    // What a browser sends for a copy cached before installation. These go separately because a server
    // ignores If-Modified-Since when If-None-Match is present.
    const stock = await rawRequest('/web/', {method: 'HEAD'});
    for (const validator of [
        {'If-None-Match': stock.headers.etag},
        {'If-Modified-Since': new Date().toUTCString()},
    ]) {
        const stale = await rawRequest('/web/', {headers: validator});
        expect(stale.status).toBe(200);
        expect(tags(stale.text).length).toBe(1);
    }
});

test('a range request gets the whole document', async () => {
    const {status, text} = await rawRequest('/web/', {headers: {Range: 'bytes=0-10'}});
    expect(status).toBe(200);
    expect(tags(text).length).toBe(1);
});

test('client.js is public and its caching follows the version', async () => {
    const {text} = await rawRequest('/web/');
    const url = new URL(tags(text)[0][1], `${server.url}/web/`);

    const versioned = await rawRequest(`/Yomitan/client.js${url.search}`);
    expect(versioned.status).toBe(200);
    expect(versioned.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(versioned.headers['cache-control']).toContain('immutable');
    expect(versioned.text).toContain('__yomitanJellyfin');

    const unversioned = await rawRequest('/Yomitan/client.js');
    expect(unversioned.headers['cache-control']).toBe('no-cache');

    const older = await rawRequest('/Yomitan/client.js?v=0000000000000000');
    expect(older.headers['cache-control']).toBe('no-cache');

    const revalidated = await rawRequest('/Yomitan/client.js', {headers: {'If-None-Match': versioned.headers.etag}});
    expect(revalidated.status).toBe(304);
});

test('with a BaseUrl, the index outside it is not ours to edit', async () => {
    test.skip(server.prefix === '', 'Needs JF_BASE_URL');

    const unprefixed = await fetch(`${server.origin}/web/`, {redirect: 'manual'});
    expect(await unprefixed.text()).not.toContain('data-yomitan-client');
});

test.describe('engine.js', () => {
    const engineUrl = async () => {
        const {text} = await rawRequest('/web/');
        const script = new URL(tags(text)[0][1], `${server.url}/web/`);
        const loader = (await rawRequest(`/Yomitan/client.js${script.search}`)).text;
        return /engine\.js\?v=([0-9a-f]{16})/.exec(loader)[0];
    };

    test('the loader names the hash the server serves it under', async () => {
        const url = await engineUrl();
        const {status, headers} = await rawRequest(`/Yomitan/${url}`);
        expect(status).toBe(200);
        expect(headers['content-type']).toBe('text/javascript; charset=utf-8');
        expect(headers['cache-control']).toContain('immutable');
        expect(headers.etag).toBe(`"${url.split('=')[1]}"`);
    });

    test('it is public, and its caching follows the version', async () => {
        const unversioned = await rawRequest('/Yomitan/engine.js');
        expect(unversioned.status).toBe(200);
        expect(unversioned.headers['cache-control']).toBe('no-cache');

        const older = await rawRequest('/Yomitan/engine.js?v=0000000000000000');
        expect(older.headers['cache-control']).toBe('no-cache');

        const revalidated = await rawRequest('/Yomitan/engine.js', {headers: {'If-None-Match': unversioned.headers.etag}});
        expect(revalidated.status).toBe(304);
    });

    test('anonymous access stops at the scripts', async () => {
        const query = await rawRequest('/Yomitan/Query', {method: 'POST'});
        expect(query.status).toBe(401);
    });

    test('compression reaches it, and the loader stays small', async () => {
        const {body, headers} = await rawRequest('/Yomitan/engine.js', {headers: {'Accept-Encoding': 'br'}});
        expect(headers['content-encoding']).toBe('br');
        expect(body.length).toBeLessThan(100 * 1024);

        const {text} = await rawRequest('/web/');
        const script = new URL(tags(text)[0][1], `${server.url}/web/`);
        const loader = await rawRequest(`/Yomitan/client.js${script.search}`);
        expect(loader.body.length).toBeLessThan(3 * 1024);
    });

    test('it carries Yomitan\'s license notice', async () => {
        const {text} = await rawRequest('/Yomitan/engine.js');
        expect(text.slice(0, 500)).toContain('Yomitan Authors');
        expect(text.slice(0, 500)).toContain('GNU General Public License');
    });
});
