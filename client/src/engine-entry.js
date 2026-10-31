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
 * @returns {PlaybackController}
 */
export function startPlugin({playbackManager, events}) {
    const controller = new PlaybackController({playbackManager, events});
    controller.start();
    return controller;
}
