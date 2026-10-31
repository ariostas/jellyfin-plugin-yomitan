// Runs on every page of jellyfin-web, so it stays tiny: it waits for a video to start, and only then fetches the engine.
/* global __CLIENT_VERSION__, __ENGINE_VERSION__ */
import {findPlaybackManager} from './player-hook.js';
import {Settings} from './settings.js';

function load() {
    // Relative to this script, so it works under a BaseUrl or a reverse proxy's prefix.
    const engineUrl = new URL(`engine.js?v=${__ENGINE_VERSION__}`, document.currentScript.src).href;
    const settings = new Settings();
    const state = {version: __CLIENT_VERSION__, settings};
    window.__yomitanJellyfin = state;
    console.info(`[yomitan] client ${__CLIENT_VERSION__} loaded`);

    findPlaybackManager((playbackManager, events) => {
        const isVideo = (player) => {
            try {
                return Boolean(player) && playbackManager.isPlayingVideo(player);
            } catch {
                return false;
            }
        };

        let started = false;
        const startEngine = async () => {
            if (started || !settings.get('enabled')) {
                return;
            }

            started = true;
            events.off(playbackManager, 'playbackstart', onPlaybackStart);
            try {
                const {startPlugin} = await import(engineUrl);
                state.playback = startPlugin({playbackManager, events, settings});
            } catch (error) {
                console.warn('[yomitan] the engine failed to load, so subtitles stay as they are:', error);
            }
        };

        const onPlaybackStart = (_event, player) => {
            if (isVideo(player)) {
                startEngine();
            }
        };

        const startIfPlaying = () => {
            if (isVideo(playbackManager.getCurrentPlayer())) {
                startEngine();
            }
        };

        events.on(playbackManager, 'playbackstart', onPlaybackStart);
        settings.addEventListener('change', startIfPlaying);
        startIfPlaying();
    });
}

if (!window.__yomitanJellyfin) {
    load();
}
