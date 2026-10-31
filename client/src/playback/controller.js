// Follows the page's playback and keeps exactly one session for what is on screen. Everything it knows comes from this
// tab's own playbackManager: the Sessions API cannot tell two tabs apart, because they share a deviceId and so one
// session on the server, which holds whichever tab reported last.
import {Engine} from '../engine/engine.js';
import {PlaybackSession} from './session.js';

/**
 * Track switches fire no event a plugin can reach, and neither do offset changes, so this polls. It only runs during
 * video playback, and reads a few fields.
 */
const POLL_INTERVAL_MS = 250;

const VIDEO_SELECTOR = 'video.htmlvideoplayer';

/** What a session needs to know about the current playback, read fresh each time. */
class PlaybackView {
    constructor(playbackManager, player) {
        this._playbackManager = playbackManager;
        this._player = player;
    }

    /** @returns {object|null} A description of what is playing, or null if nothing is. */
    read() {
        const manager = this._playbackManager;
        const player = this._player;
        const item = manager.currentItem(player);
        const mediaSource = manager.currentMediaSource(player);
        if (!item || !mediaSource) {
            return null;
        }

        const index = manager.getSubtitleStreamIndex(player);
        const stream = index === null || index === undefined || index < 0 ?
            null :
            manager.subtitleTracks(player).find(({Index}) => Index === index) ?? null;
        return {
            key: `${item.Id}/${mediaSource.Id}/${stream?.Index ?? 'none'}/${stream?.DeliveryMethod ?? ''}`,
            itemId: item.Id,
            mediaSourceId: mediaSource.Id,
            stream,
        };
    }

    /** @returns {number} jellyfin-web's subtitle offset. It lives in the player and resets with each track. */
    subtitleOffset() {
        return this._playbackManager.getPlayerSubtitleOffset(this._player) ?? 0;
    }

    /** @returns {number} Where a progressive transcode started, which its timestamps do not include. */
    transcodingOffset() {
        return (this._player._currentPlayOptions?.transcodingOffsetTicks ?? 0) / 1e7;
    }

    /** @returns {boolean} */
    hasSecondarySubtitles() {
        return (this._playbackManager.getSecondarySubtitleStreamIndex(this._player) ?? -1) >= 0;
    }
}

export class PlaybackController extends EventTarget {
    /**
     * @param {object} options
     * @param {object} options.playbackManager jellyfin-web's playbackManager.
     * @param {object} options.events jellyfin-web's Events.
     */
    constructor({playbackManager, events}) {
        super();
        this.playbackManager = playbackManager;
        this._events = events;
        this._view = null;
        this._timer = 0;
        this._key = null;
        this._video = null;
        /** @type {PlaybackSession|null} The session for the current track, if any. */
        this.session = null;
        /** @type {Engine|null} Created for the first Japanese track, since preparing it takes a moment. */
        this.engine = null;
    }

    /** Starts following playback, including one already under way. */
    start() {
        this._events.on(this.playbackManager, 'playbackstart', this._onPlaybackStart);
        this._events.on(this.playbackManager, 'playbackstop', this._onPlaybackStop);
        this._follow(this.playbackManager.getCurrentPlayer());
    }

    _onPlaybackStart = (_event, player) => this._follow(player);

    _onPlaybackStop = () => this._check();

    _follow(player) {
        if (!player || !this.playbackManager.isPlayingVideo(player)) {
            return;
        }

        this._view = new PlaybackView(this.playbackManager, player);
        if (this._timer === 0) {
            this._timer = setInterval(this._check, POLL_INTERVAL_MS);
        }

        this._check();
    }

    _check = () => {
        let playing = null;
        try {
            playing = this._view?.read() ?? null;
        } catch (error) {
            console.warn('[yomitan] cannot read the playback state:', error);
        }

        const video = document.querySelector(VIDEO_SELECTOR);
        if (!playing || !video) {
            this._stopFollowing();
            return;
        }

        if (playing.key !== this._key || video !== this._video) {
            this._key = playing.key;
            this._video = video;
            this._replaceSession(playing, video);
        }

        this.session?.poll();
    };

    _replaceSession(playing, video) {
        this._closeSession();
        if (!playing.stream) {
            return;
        }

        const view = this._view;
        const playback = {
            stream: playing.stream,
            source: {apiClient: window.ApiClient, itemId: playing.itemId, mediaSourceId: playing.mediaSourceId},
            subtitleOffset: () => view.subtitleOffset(),
            transcodingOffset: () => view.transcodingOffset(),
            hasSecondarySubtitles: () => view.hasSecondarySubtitles(),
        };
        this.session = new PlaybackSession({
            playback,
            video,
            getEngine: () => {
                this.engine ??= new Engine();
                return this.engine;
            },
            emit: (type, detail) => this.dispatchEvent(new CustomEvent(type, {detail: {...detail, session: this.session}})),
        });
        this.dispatchEvent(new CustomEvent('session', {detail: {session: this.session}}));
        this.session.start();
    }

    _closeSession() {
        if (this.session) {
            this.session.dispose();
            this.session = null;
            this.engine?.close();
            this.dispatchEvent(new CustomEvent('session', {detail: {session: null}}));
        }
    }

    _stopFollowing() {
        this._closeSession();
        clearInterval(this._timer);
        this._timer = 0;
        this._key = null;
        this._video = null;
        this._view = null;
    }
}
