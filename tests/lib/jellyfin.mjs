// Helpers for talking to a server started by scripts/dev.sh. They read the same JF_* variables it does.
import http from 'node:http';
import {expect} from '@playwright/test';

const port = process.env.JF_PORT ?? '18096';
const prefix = process.env.JF_BASE_URL ?? '';

export const server = {
    name: process.env.JF_NAME ?? 'jf-yomitan',
    origin: `http://127.0.0.1:${port}`,
    prefix,
    url: `http://127.0.0.1:${port}${prefix}`,
    withFileTransformation: process.env.JF_WITH_FT === '1',
};

export const credentials = {username: 'spike', password: 'spike'};

export const clientScript = 'script[data-yomitan-client]';

const authHeader = 'MediaBrowser Client="yomitan-tests", Device="tests", DeviceId="yomitan-tests", Version="1"';

let adminToken;

/** Calls the Jellyfin API as the admin and returns the parsed response, or null if it has no body. */
export async function api(path, {method = 'GET', body} = {}) {
    adminToken ??= (await login()).AccessToken;
    const response = await fetch(server.url + path, {
        method,
        headers: {Authorization: `${authHeader}, Token="${adminToken}"`, 'Content-Type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`${method} ${path} returned ${response.status}: ${await response.text()}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

async function login() {
    const response = await fetch(`${server.url}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: {Authorization: authHeader, 'Content-Type': 'application/json'},
        body: JSON.stringify({Username: credentials.username, Pw: credentials.password}),
    });
    expect(response.ok).toBe(true);
    return response.json();
}

/**
 * Sends one request and returns it exactly as the server answered. fetch() would decompress the body and
 * hide what the headers really describe.
 */
export function rawRequest(path, {method = 'GET', headers = {}} = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request(`${server.url}${path}`, {method, headers}, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const body = Buffer.concat(chunks);
                resolve({status: response.statusCode, headers: response.headers, body, text: body.toString('utf8')});
            });
        });
        request.on('error', reject);
        request.end();
    });
}

/** Returns the id of each movie, keyed by file name without the year. */
export async function getMovies() {
    const [user] = await api('/Users');
    const {Items: items} = await api(`/Items?userId=${user.Id}&recursive=true&includeItemTypes=Movie`);
    return Object.fromEntries(items.map((item) => [item.Name.replace(/ \(\d{4}\)$/, ''), item.Id]));
}

/** Opens jellyfin-web and logs in through the form. */
export async function logIn(page) {
    await page.goto('web/');
    await page.locator('#txtManualName, .btnManual').first().waitFor();
    if (await page.locator('.btnManual').isVisible()) {
        await page.locator('.btnManual').click();
    }
    await page.locator('#txtManualName').fill(credentials.username);
    await page.locator('#txtManualPassword').fill(credentials.password);
    await page.locator('.manualLoginForm .button-submit').click();
    await page.waitForURL(/#\/home/);
}

/**
 * Starts a movie in the page's own client through the Sessions API, the way "play on" does. Going through
 * the UI would tie every test to the layout, and playbackManager is not reachable from the page.
 */
export async function play(page, itemId, {minimumTime = 3} = {}) {
    const deviceId = await page.evaluate(() => window.ApiClient.deviceId());
    let session;
    await expect.poll(async () => {
        [session] = await api(`/Sessions?deviceId=${encodeURIComponent(deviceId)}`);
        return session?.Id;
    }).toBeTruthy();

    await api(`/Sessions/${session.Id}/Playing?playCommand=PlayNow&itemIds=${itemId}`, {method: 'POST'});
    await page.waitForFunction((time) => {
        const video = document.querySelector('video.htmlvideoplayer');
        return video && video.currentTime > time && !video.paused;
    }, minimumTime, {timeout: 45_000});
    return session.Id;
}
