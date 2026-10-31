// Drives the real engine bundle in a logged-in page, against the real server.
import {logIn, server} from './jellyfin.mjs';

/** Logs in and loads the engine as `window.engineModule`, with an open Engine as `window.engine`. */
export async function openEngine(page) {
    await logIn(page);
    await page.evaluate(async (url) => {
        window.engineModule = await import(url);
        window.engine = new window.engineModule.Engine();
        window.segmenter = new window.engineModule.Segmenter(window.engine);
        await window.engine.open(window.ApiClient);
    }, `${server.url}/Yomitan/engine.js`);
}
