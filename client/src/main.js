/* global __CLIENT_VERSION__ */

if (!window.__yomitanJellyfin) {
    window.__yomitanJellyfin = {version: __CLIENT_VERSION__};
    console.info(`[yomitan] client ${__CLIENT_VERSION__} loaded`);
}
