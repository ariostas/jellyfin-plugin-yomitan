// Finds jellyfin-web's playbackManager, which is not a global. Its events all go through the global Events object,
// so wrapping Events.trigger for a moment shows it to us, and then the wrapper goes away. If another script has wrapped
// it since, ours has to stay in their chain, and from then on it only passes calls on.

/** How long to wait for jellyfin-web to define Events before giving up, in milliseconds. */
const EVENTS_TIMEOUT_MS = 60_000;
const EVENTS_RETRY_MS = 200;

function isPlaybackManager(target) {
    return typeof target?.getCurrentPlayer === 'function'
        && typeof target.getSubtitleStreamIndex === 'function'
        && typeof target.subtitleTracks === 'function';
}

function wrapTrigger(events, onFound) {
    const original = events.trigger;
    let found = false;
    const wrapper = function (target, ...rest) {
        // Nothing here can throw into Jellyfin: the test only reads typeof, and onFound guards itself.
        if (!found && isPlaybackManager(target)) {
            found = true;
            if (events.trigger === wrapper) {
                events.trigger = original;
            }

            onFound(target);
        }

        return original.call(this, target, ...rest);
    };
    events.trigger = wrapper;
}

/**
 * Calls back once with this tab's playbackManager. It fires no earlier than the first playback event, which is before
 * the first `playbackstart`.
 * @param {(playbackManager: object, events: object) => void} onFound
 */
export function findPlaybackManager(onFound) {
    const deadline = performance.now() + EVENTS_TIMEOUT_MS;
    const attempt = () => {
        const {Events: events} = window;
        if (typeof events?.trigger === 'function') {
            wrapTrigger(events, (manager) => onFound(manager, events));
        } else if (performance.now() < deadline) {
            setTimeout(attempt, EVENTS_RETRY_MS);
        } else {
            console.debug('[yomitan] no Events object, so the plugin stays out of the way');
        }
    };
    attempt();
}
