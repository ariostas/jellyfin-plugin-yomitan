// One subtitle track of one playback, from the moment it is selected until anything about it changes. A session never
// outlives its track: a new item, a track switch or leaving the player disposes it and the controller starts another,
// so nothing carries over.
//
// The order in start() is what keeps failure safe. Jellyfin's subtitles are hidden only once the track's text, the
// dictionary API and at least one dictionary have all worked, and any later failure puts them back.
import {NoDictionariesError} from '../engine/engine.js';
import {KeyInput} from '../input/keys.js';
import {PointerInput} from '../input/pointer.js';
import {Layer} from '../layer.js';
import {Overlay} from '../overlay.js';
import {WordLookup} from '../popup/lookup.js';
import {Segmenter} from '../segmenter.js';
import {isJapaneseTrack} from '../subtitles/language.js';
import {loadCues, trackContent} from '../subtitles/source.js';
import {CueTimeline} from '../subtitles/timeline.js';
import {NativeSubtitles} from './native-subtitles.js';
import {measureOsd} from './osd.js';

/** Upcoming cues to segment ahead of time. Two covers quick exchanges. */
const PRESEGMENT_CUES = 2;
/** Bounds the measurements a long film can collect. */
const MAX_TIMINGS = 5000;

export class PlaybackSession {
    /**
     * @param {object} options
     * @param {object} options.playback Item, media source, stream and subtitle offset for this tab. See controller.js.
     * @param {HTMLVideoElement} options.video
     * @param {object} options.events jellyfin-web's Events.
     * @param {import('../settings.js').Settings} options.settings
     * @param {() => import('../engine/engine.js').Engine} options.getEngine
     * @param {(type: string, detail?: object) => void} options.emit Sends an event to the controller's listeners.
     */
    constructor({playback, video, events, settings, getEngine, emit}) {
        this._playback = playback;
        this._video = video;
        this._events = events;
        this._settings = settings;
        this._getEngine = getEngine;
        this._emit = emit;
        this._abort = new AbortController();
        /** Everything that drives the overlay. Ends with it, which can be long before the session is disposed. */
        this._driving = null;
        this._native = new NativeSubtitles(video, () => playback.subtitleOffset());
        this._layer = null;
        this._overlay = null;
        this._input = null;
        this._keys = null;
        this._timeline = null;
        this._segmenter = null;
        this._shownKey = null;
        this._animationFrame = 0;
        this._pending = [];
        this._segmenting = false;

        /** `idle`, `active` or `inactive`. Inactive means Jellyfin's subtitles are showing. */
        this.state = 'idle';
        /**
         * Why it is inactive, when that is a problem someone can act on: `none`, `disabled` or `no-terms` from
         * NoDictionariesError, or `failed`. Null for a track the plugin leaves alone on purpose.
         * @type {string|null}
         */
        this.problem = null;
        /** @type {WordLookup|null} What shows a word's popup. Null unless the state is `active`. */
        this.lookup = null;
        /** @type {readonly import('../subtitles/timeline.js').Cue[]} */
        this.cues = [];
        /** Word lists by cue id, for the cues on screen. */
        this.words = new Map();
        /** One entry per cue shown: whether its words beat it to the screen, and how late they were otherwise. */
        this.timings = [];
    }

    /** @returns {object} The subtitle stream this session is for. */
    get stream() {
        return this._playback.stream;
    }

    /** @returns {boolean} */
    get disposed() {
        return this._abort.signal.aborted;
    }

    /** @returns {number} The time in the subtitle file that matches the video now, in seconds. */
    get time() {
        return this._video.currentTime + this._playback.transcodingOffset() + this._playback.subtitleOffset();
    }

    async start() {
        const {stream} = this._playback;
        const content = trackContent(stream);
        if (content !== 'text') {
            console.debug(`[yomitan] leaving subtitle stream ${stream.Index} alone: it is ${content}`);
            this._setInactive();
            return;
        }

        try {
            const {signal} = this._abort;
            const cues = await loadCues({...this._playback.source, stream, signal});
            if (this.disposed) {
                return;
            }

            if (!isJapaneseTrack(stream, cues)) {
                console.debug(`[yomitan] leaving subtitle stream ${stream.Index} alone: it is not Japanese`);
                this._setInactive();
                return;
            }

            const engine = this._getEngine();
            await engine.open(this._playback.source.apiClient);
            if (this.disposed) {
                return;
            }

            this._activate(engine, cues);
        } catch (error) {
            this._fail(error);
        }
    }

    _setInactive() {
        this.state = 'inactive';
        this._emit('inactive');
    }

    _activate(engine, cues) {
        this._driving = new AbortController();
        const {signal} = this._driving;
        this._engine = engine;
        this._segmenter = new Segmenter(engine, {signal});
        this._timeline = new CueTimeline(cues);
        this._layer = new Layer(signal);
        this._overlay = new Overlay(this._layer.element);
        this._overlay.setFontScale(this._settings.get('fontScale'));
        this._settings.addEventListener('change', this._onSettingChanged, {signal});
        this.lookup = new WordLookup({
            engine,
            overlay: this._overlay,
            container: this._layer.element,
            video: this._video,
            apiClient: this._playback.source.apiClient,
            wordsOf: (cueId) => this.words.get(cueId),
            osd: measureOsd,
            signal,
        });
        this._input = new PointerInput({lookup: this.lookup, overlay: this._overlay, settings: this._settings, signal});
        this._keys = new KeyInput({
            lookup: this.lookup,
            overlay: this._overlay,
            pointer: this._input,
            video: this._video,
            settings: this._settings,
            cues: () => this.cues,
            wordsOf: (cueId) => this.words.get(cueId),
            signal,
        });
        this._events.on(document, 'SHOW_VIDEO_OSD', this._onOsdToggled);
        this._native.hide();
        this.state = 'active';

        engine.addEventListener('dictionarieschange', this._onDictionariesChanged, {signal});
        const render = () => this._safely(() => this._render());
        for (const type of ['timeupdate', 'seeking', 'seeked', 'pause', 'play', 'ratechange']) {
            this._video.addEventListener(type, render, {signal});
        }

        this._video.addEventListener('play', this._startAnimation, {signal});
        this._emit('active', {cues});
        this._render();
        this._startAnimation();
    }

    /** Runs on the controller's timer, which also runs while paused, when the video has no events to offer. */
    poll() {
        if (this.state === 'active') {
            this._safely(() => {
                this._native.enforce();
                this._overlay.setBelowSecondary(this._playback.hasSecondarySubtitles());
                this._followOsd();
                this._render();
            });
        }
    }

    /**
     * Runs what timers and events do once the overlay is up. A throw there reaches nobody and comes back on the next
     * tick, with Jellyfin's subtitles hidden all the while, as when jellyfin-web renames a method this reads.
     */
    _safely(work) {
        try {
            work();
        } catch (error) {
            this._fail(error);
        }
    }

    /** The first event comes before jellyfin-web has shown the OSD, so this looks a frame later. */
    _onOsdToggled = () => {
        requestAnimationFrame(() => {
            if (this.state === 'active') {
                this._safely(() => this._followOsd());
            }
        });
    };

    /**
     * Moves the lines clear of the OSD, unless a word is in use: the OSD comes and goes by itself, and the word under the
     * mouse must not move away from it.
     */
    _followOsd() {
        if (!this.lookup.current && !this._input.busy) {
            this._overlay.setInsets(measureOsd());
        }
    }

    _startAnimation = () => {
        if (this._animationFrame === 0 && !this.disposed) {
            this._animationFrame = requestAnimationFrame(this._onAnimationFrame);
        }
    };

    _onAnimationFrame = () => {
        this._animationFrame = 0;
        if (this.state === 'active') {
            this._safely(() => this._render());
            if (this.state === 'active' && !this._video.paused) {
                this._startAnimation();
            }
        }
    };

    _render() {
        const {time} = this;
        const {key, cues} = this._timeline.at(time);
        if (key === this._shownKey) {
            return;
        }

        this._shownKey = key;
        this.cues = cues;
        this.words = new Map();
        for (const cue of cues) {
            const words = this._segmenter.peek(cue.text);
            if (words) {
                this.words.set(cue.id, words);
            }

            if (this.timings.length < MAX_TIMINGS) {
                this.timings.push({id: cue.id, ready: Boolean(words), shownAt: performance.now()});
            }
        }

        this._overlay.show(cues, (cue) => this.words.get(cue.id));
        // A seek under way, or an offset changed while paused, can take the line away from a word that is showing.
        if (this.lookup.current && !cues.some(({id}) => id === this.lookup.current.cueId)) {
            this.lookup.close('gone');
        }

        this._emit('cuechange', {cues});
        this._keys.linesChanged();
        this._queueSegmentation(time, cues);
    }

    _queueSegmentation(time, cues) {
        const upcoming = this._timeline.upcoming(time, PRESEGMENT_CUES);
        this._pending = [...cues, ...upcoming].filter(({text}) => !this._segmenter.peek(text));
        if (!this._segmenting) {
            this._segmentPending();
        }
    }

    async _segmentPending() {
        this._segmenting = true;
        try {
            for (let cue = this._pending.shift(); cue && !this.disposed; cue = this._pending.shift()) {
                const words = await this._segmenter.segment(cue.text);
                if (!this.disposed) {
                    this._deliverWords(cue, words);
                }
            }
        } catch (error) {
            this._fail(error);
        } finally {
            this._segmenting = false;
        }
    }

    _deliverWords(cue, words) {
        // Two cues can share a text, so match on that and not on the cue that was queued.
        for (const shown of this.cues) {
            if (shown.text === cue.text && !this.words.has(shown.id)) {
                this.words.set(shown.id, words);
                this._overlay.setWords(shown, words);
                this._noteLate(shown);
                this._emit('words', {cue: shown, words});
                this._keys.linesChanged();
            }
        }
    }

    _noteLate({id}) {
        const timing = this.timings.findLast((entry) => entry.id === id);
        if (timing && !timing.ready) {
            timing.lateMs = performance.now() - timing.shownAt;
        }
    }

    _onSettingChanged = ({detail: {name, value}}) => {
        if (name === 'fontScale') {
            this._safely(() => this._overlay.setFontScale(value));
        }
    };

    _onDictionariesChanged = () => this._safely(() => {
        this._segmenter.clear();
        const {unusable} = this._engine;
        if (unusable) {
            this._fail(new NoDictionariesError(unusable));
            return;
        }

        // What it shows came from the old set, and the word under it may not exist in the new one.
        this.lookup.close('gone');
        this._shownKey = null;
        this._render();
    });

    /** Any failure of ours ends here, with Jellyfin's subtitles showing. */
    _fail(error) {
        if (this.disposed || error.name === 'AbortError') {
            return;
        }

        if (error instanceof NoDictionariesError) {
            console.info(`[yomitan] subtitles stay as they are: ${error.message}`);
        } else {
            console.warn('[yomitan] subtitles stay as they are:', error);
        }

        this.problem = error.reason ?? 'failed';
        this._tearDown({playing: true});
        this._setInactive();
    }

    /** @param {{playing: boolean}} options Whether the video lives on, so a pause of ours can be undone. */
    _tearDown(options) {
        this._events.off(document, 'SHOW_VIDEO_OSD', this._onOsdToggled);
        this.lookup?.destroy(options);
        this.lookup = null;
        this._input = null;
        this._keys = null;
        this._driving?.abort();
        cancelAnimationFrame(this._animationFrame);
        this._animationFrame = 0;
        this._pending = [];
        this._native.restore();
        this._overlay?.destroy();
        this._overlay = null;
        this._layer?.destroy();
        this._layer = null;
        this.cues = [];
        this.words = new Map();
    }

    /** @param {{playing: boolean}} options Whether the video lives on, so a pause of ours can be undone. */
    dispose(options) {
        this._abort.abort();
        this._tearDown(options);
        this.state = 'idle';
    }
}
