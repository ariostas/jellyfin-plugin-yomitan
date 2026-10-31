// The engine script, which the loader imports when a video starts.
import {Engine} from './engine/engine.js';
import {PlaybackController} from './playback/controller.js';
import {candidatesFrom, Segmenter} from './segmenter.js';

// The tests drive these directly, against the real server.
export {candidatesFrom, Engine, Segmenter};

/**
 * Starts following playback.
 * @param {object} options
 * @param {object} options.playbackManager jellyfin-web's playbackManager, for this tab.
 * @param {object} options.events jellyfin-web's Events.
 * @param {import('./settings.js').Settings} options.settings The loader's settings.
 * @returns {PlaybackController}
 */
export function startPlugin({playbackManager, events, settings}) {
    const controller = new PlaybackController({playbackManager, events, settings});
    controller.start();
    return controller;
}
