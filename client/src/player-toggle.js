// The button in the OSD that turns the plugin on and off during playback. `enabled` is off by default, so this is where
// most people meet it. It stands next to the subtitle button, and is only there for a track the plugin could do
// something with. With the feature off, the engine is not loaded and the session that decides this does not exist, so
// the decision is made here, with the same functions the session uses.
//
// Everything here reads jellyfin-web's DOM, which is not a contract. Anything missing means no button, and nothing else.
import {isJapaneseTrack, languageNeedsText} from './subtitles/language.js';
import {fetchTimedText, trackContent, trackPath} from './subtitles/source.js';
import {element} from './ui/dom.js';
import {showNotice} from './ui/notice.js';

/** Track switches fire no event a plugin can reach. See playback/controller.js. */
const POLL_INTERVAL_MS = 500;
const SUBTITLE_BUTTON = '.page:not(.hide) .videoOsdBottom .btnSubtitles';
const ON_COLOR = 'var(--jf-palette-primary-main, #00a4dc)';
const PROBLEM_COLOR = '#ffb300';

const PROBLEMS = {
    none: 'Yomitan has no dictionaries yet, so subtitles stay as they are. An administrator can add them in the dashboard, under Yomitan.',
    disabled: 'All your Yomitan dictionaries are turned off, so subtitles stay as they are. Settings, Yomitan has the list.',
    'no-terms': 'The Yomitan dictionaries you have on hold no words, so subtitles stay as they are. Settings, Yomitan has the list.',
    failed: 'Yomitan could not start on this track, so subtitles stay as they are.',
};

export class PlayerToggle {
    /**
     * @param {object} options
     * @param {object} options.playbackManager jellyfin-web's playbackManager.
     * @param {object} options.events jellyfin-web's Events.
     * @param {import('./settings.js').Settings} options.settings
     */
    constructor({playbackManager, events, settings}) {
        this._manager = playbackManager;
        this._events = events;
        this._settings = settings;
        this._timer = 0;
        this._button = null;
        this._trackKey = null;
        this._applies = false;
        this._decision = null;
        this._problem = null;
    }

    /** Starts following playback, including one already under way. */
    start() {
        this._events.on(this._manager, 'playbackstart', this._follow);
        this._events.on(this._manager, 'playbackstop', this._check);
        this._settings.addEventListener('change', this._onSettingChanged);
        this._follow();
    }

    /** @param {EventTarget} controller The PlaybackController, to hear from once the engine has started it. */
    watch(controller) {
        controller.addEventListener('inactive', ({detail: {session}}) => this.report(session?.problem ?? null));
    }

    /**
     * Says why turning this on did nothing, on the button and in a notice.
     * @param {keyof typeof PROBLEMS|null} problem
     */
    report(problem) {
        this._problem = problem;
        this._render();
        if (problem && this._settings.get('enabled')) {
            showNotice(PROBLEMS[problem]);
        }
    }

    _onSettingChanged = ({detail: {name}}) => {
        if (name === 'enabled') {
            this._problem = null;
            this._render();
        }
    };

    _follow = () => {
        if (this._timer === 0) {
            this._timer = setInterval(this._check, POLL_INTERVAL_MS);
        }

        this._check();
    };

    _check = () => {
        try {
            const playing = this._readTrack();
            if (!playing) {
                this._stop();
                return;
            }

            this._decide(playing);
            if (this._applies) {
                this._place();
            } else {
                this._remove();
            }
        } catch (error) {
            console.debug('[yomitan] leaving the OSD alone:', error);
            this._stop();
        }
    };

    /** @returns {object|null} The selected track of the video playing now. Null if no video is. */
    _readTrack() {
        const manager = this._manager;
        const player = manager.getCurrentPlayer();
        if (!player || !manager.isPlayingVideo(player)) {
            return null;
        }

        const item = manager.currentItem(player);
        const mediaSource = manager.currentMediaSource(player);
        if (!item || !mediaSource) {
            return null;
        }

        const index = manager.getSubtitleStreamIndex(player);
        const stream = manager.subtitleTracks(player).find(({Index}) => Index === index) ?? null;
        return {key: `${item.Id}/${mediaSource.Id}/${stream?.Index}/${stream?.DeliveryMethod}`, itemId: item.Id, mediaSourceId: mediaSource.Id, stream};
    }

    /** Works out once per track whether the button belongs here. */
    _decide({key, itemId, mediaSourceId, stream}) {
        if (key === this._trackKey) {
            return;
        }

        this._trackKey = key;
        this._applies = false;
        this._problem = null;
        this._decision?.abort();
        this._decision = null;
        if (!stream || trackContent(stream) !== 'text') {
            return;
        }

        if (!languageNeedsText(stream)) {
            this._applies = isJapaneseTrack(stream, []);
            return;
        }

        // No tag, so only the text can say. That is one small request, and only for such a track.
        const decision = new AbortController();
        this._decision = decision;
        fetchTimedText(window.ApiClient, trackPath(itemId, mediaSourceId, stream), decision.signal).then((cues) => {
            if (this._decision === decision) {
                this._applies = isJapaneseTrack(stream, cues);
                this._check();
            }
        }, (error) => {
            console.debug('[yomitan] cannot read this track, so it gets no button:', error);
        });
    }

    _place() {
        const anchor = document.querySelector(SUBTITLE_BUTTON);
        if (!anchor?.parentElement) {
            this._remove();
            return;
        }

        if (!this._button) {
            this._button = this._create();
        }

        if (this._button.previousElementSibling !== anchor) {
            anchor.after(this._button);
        }
    }

    _create() {
        // The same classes as its neighbours, so it looks like one. jellyfin-web's focus handling takes any button.
        const button = element(
            'button',
            {type: 'button', class: 'btnYomitan autoSize paper-icon-button-light', on: {click: this._onClick}},
            element('span', {class: 'xlargePaperIconButton material-icons translate', 'aria-hidden': 'true'}),
        );
        this._button = button;
        this._render();
        return button;
    }

    _onClick = () => {
        this._settings.set('enabled', !this._settings.get('enabled'));
    };

    _render() {
        if (!this._button) {
            return;
        }

        const enabled = this._settings.get('enabled');
        const label = `Yomitan lookups: ${enabled ? 'on' : 'off'}${this._problem ? ', not working' : ''}`;
        this._button.title = label;
        this._button.setAttribute('aria-label', label);
        this._button.setAttribute('aria-pressed', `${enabled}`);
        if (enabled) {
            this._button.style.color = this._problem ? PROBLEM_COLOR : ON_COLOR;
        } else {
            this._button.style.removeProperty('color');
        }
    }

    _remove() {
        this._button?.remove();
        this._button = null;
    }

    _stop() {
        clearInterval(this._timer);
        this._timer = 0;
        this._trackKey = null;
        this._applies = false;
        this._problem = null;
        this._decision?.abort();
        this._decision = null;
        this._remove();
    }
}
