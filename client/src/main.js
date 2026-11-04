// Runs on every page of jellyfin-web, so it stays small: it keeps the user's settings, adds the way to them, and puts a
// button in the OSD. Only a video someone turned the feature on for fetches the engine.
/* global __CLIENT_VERSION__, __ENGINE_VERSION__, __SETTINGS_PAGE_VERSION__ */
import {findPlaybackManager} from './player-hook.js';
import {PlayerToggle} from './player-toggle.js';
import {Settings} from './settings.js';
import {showNotice} from './ui/notice.js';
import {addSettingsLink} from './ui/settings-link.js';

const SYNC_NOTICES = {
    retrying: 'Your Yomitan setting has not reached the server. It applies here, and will be sent again.',
    refused: 'The server refused a Yomitan setting, so it went back to what it was.',
};

function load() {
    // Relative to this script, so it works under a BaseUrl or a reverse proxy's prefix.
    const scriptUrl = (path) => new URL(path, document.currentScript.src).href;
    const engineUrl = scriptUrl(`engine.js?v=${__ENGINE_VERSION__}`);
    const settingsPageUrl = scriptUrl(`settings-page.js?v=${__SETTINGS_PAGE_VERSION__}`);
    const settings = new Settings();
    const state = {version: __CLIENT_VERSION__, settings};
    window.__yomitanJellyfin = state;
    console.info(`[yomitan] client ${__CLIENT_VERSION__} loaded`);

    const loadSettingsPage = () => import(settingsPageUrl);
    const openSettings = async () => {
        try {
            const {openSettingsPage} = await loadSettingsPage();
            openSettingsPage(settings);
        } catch (error) {
            console.warn('[yomitan] the settings page failed to load:', error);
            showNotice('The Yomitan settings could not be loaded.');
        }
    };

    // jellyfin-web has no event a plugin can reach for signing in or out, and every page sends this when it shows.
    window.addEventListener('viewshow', () => {
        settings.follow();
        addSettingsLink(openSettings);
    });
    // A phone comes back here after someone used their laptop, with no page or video starting.
    window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            settings.refresh();
        }
    });
    settings.addEventListener('syncstate', ({detail: {state: syncState}}) => {
        if (SYNC_NOTICES[syncState]) {
            showNotice(SYNC_NOTICES[syncState]);
        }
    });
    settings.follow();

    findPlaybackManager((playbackManager, events) => {
        state.playbackManager = playbackManager;
        const isVideo = (player) => {
            try {
                return Boolean(player) && playbackManager.isPlayingVideo(player);
            } catch {
                return false;
            }
        };

        const toggle = new PlayerToggle({playbackManager, events, settings, loadIntro: loadSettingsPage});
        let started = false;
        const startEngine = async () => {
            if (started || !settings.get('enabled')) {
                return;
            }

            started = true;
            try {
                const {startPlugin} = await import(engineUrl);
                state.playback = startPlugin({playbackManager, events, settings});
                toggle.watch(state.playback);
            } catch (error) {
                console.warn('[yomitan] the engine failed to load, so subtitles stay as they are:', error);
                started = false;
                toggle.report('failed');
            }
        };

        const startIfPlaying = () => {
            if (isVideo(playbackManager.getCurrentPlayer())) {
                startEngine();
            }
        };

        // follow() only reads memory and localStorage, so the video does not wait. What the server says comes as a change.
        const onPlaybackStart = (_event, player) => {
            if (isVideo(player)) {
                settings.follow();
                settings.refresh({force: true});
                startEngine();
            }
        };

        events.on(playbackManager, 'playbackstart', onPlaybackStart);
        settings.addEventListener('change', startIfPlaying);
        toggle.start();
        if (isVideo(playbackManager.getCurrentPlayer())) {
            onPlaybackStart(null, playbackManager.getCurrentPlayer());
        }
    });
}

if (!window.__yomitanJellyfin) {
    load();
}
