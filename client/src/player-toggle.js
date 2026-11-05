// The button in the OSD that turns the plugin on and off during playback. `enabled` is off by default, so this is where
// most people meet it. It stands next to the subtitle button, and is only there for a track the plugin could do
// something with. With the feature off, the engine is not loaded and the session that decides this does not exist, so
// the decision is made here, with the same functions the session uses. A track with no language tag is rare, and only
// its text can decide, so what reads it is in the settings page's script, which this fetches for it.
//
// Everything here reads jellyfin-web's DOM, which is not a contract. Anything missing means no button, and nothing else.
import {hasJapaneseTag, languageNeedsText} from './subtitles/language.js';
import {trackContent} from './subtitles/source.js';
import {element} from './ui/dom.js';
import {showNotice} from './ui/notice.js';

/** Track switches fire no event a plugin can reach. See playback/controller.js. */
const POLL_INTERVAL_MS = 500;
const SUBTITLE_BUTTON = '.page:not(.hide) .videoOsdBottom .btnSubtitles';
const ON_COLOR = 'var(--jf-palette-primary-main, #00a4dc)';
const PROBLEM_COLOR = '#ffb300';

/** When the engine itself did not load. What it finds wrong it words itself, in `PROBLEMS` in playback/controller.js. */
const FAILED = 'Yomitan could not start on this track, so subtitles stay as they are.';

export class PlayerToggle {
    // Private, which the minifier shortens, as this is in the loader.
    #manager;
    #events;
    #settings;
    #loadSettingsPage;
    #timer = 0;
    #button = null;
    #trackKey = null;
    #applies = false;
    #decision = null;
    /** What is wrong, in words, or null. */
    #problem = null;
    /** Whether the notice that introduces the button has been shown on this page, which is once at most. */
    #introduced = false;
    #closeIntro = null;

    /**
     * @param {object} options
     * @param {object} options.playbackManager jellyfin-web's playbackManager.
     * @param {object} options.events jellyfin-web's Events.
     * @param {import('./settings.js').Settings} options.settings
     * @param {() => Promise<{showIntro: Function, readsAsJapanese: Function}>} options.loadSettingsPage Fetches the
     *   settings page's script, which also holds the notice that introduces the button, and what reads an untagged track.
     */
    constructor({playbackManager, events, settings, loadSettingsPage}) {
        this.#manager = playbackManager;
        this.#events = events;
        this.#settings = settings;
        this.#loadSettingsPage = loadSettingsPage;
    }

    /** Starts following playback, including one already under way. */
    start() {
        this.#events.on(this.#manager, 'playbackstart', this.#follow);
        this.#events.on(this.#manager, 'playbackstop', this.#check);
        this.#settings.addEventListener('change', this.#onSettingChanged);
        this.#follow();
    }

    /** @param {EventTarget} controller The PlaybackController, to hear from once the engine has started it. */
    watch(controller) {
        controller.addEventListener('inactive', ({detail: {session}}) => this.report(session?.problem ?? null, controller.problems));
    }

    /**
     * Says why turning this on did nothing, on the button, in its label and tooltip too, and in a notice.
     * @param {string|null} problem A session's `problem`, or `failed`.
     * @param {Record<string, string>} [words] What each problem means.
     */
    report(problem, words = {}) {
        this.#problem = problem && (words[problem] ?? FAILED);
        this.#render();
        if (this.#problem && this.#settings.get('enabled')) {
            showNotice(this.#problem);
        }
    }

    #onSettingChanged = ({detail: {name}}) => {
        if (name === 'enabled') {
            this.#problem = null;
            this.#render();
        }
    };

    #follow = () => {
        if (this.#timer === 0) {
            this.#timer = setInterval(this.#check, POLL_INTERVAL_MS);
        }

        this.#check();
    };

    #check = () => {
        try {
            const playing = this.#readTrack();
            if (!playing) {
                this.#stop();
                return;
            }

            this.#decide(playing);
            if (this.#applies) {
                this.#place();
                this.#introduce();
            } else {
                this.#remove();
            }
        } catch (error) {
            console.debug('[yomitan] leaving the OSD alone:', error);
            this.#stop();
        }
    };

    /** @returns {object|null} The selected track of the video playing now. Null if no video is. */
    #readTrack() {
        const manager = this.#manager;
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
    #decide({key, itemId, mediaSourceId, stream}) {
        if (key === this.#trackKey) {
            return;
        }

        this.#forgetTrack(key);
        if (!stream || trackContent(stream) !== 'text') {
            return;
        }

        if (!languageNeedsText(stream)) {
            this.#applies = hasJapaneseTag(stream);
            return;
        }

        // No tag, so only the text can say. That is one small request, and only for such a track.
        const decision = new AbortController();
        this.#decision = decision;
        this.#loadSettingsPage().then(({readsAsJapanese}) => (
            readsAsJapanese(window.ApiClient, {itemId, mediaSourceId, stream}, decision.signal)
        )).then((japanese) => {
            if (this.#decision === decision) {
                this.#applies = japanese;
                this.#check();
            }
        }, (error) => {
            console.debug('[yomitan] cannot read this track, so it gets no button:', error);
        });
    }

    #place() {
        const anchor = document.querySelector(SUBTITLE_BUTTON);
        if (!anchor?.parentElement) {
            this.#remove();
            return;
        }

        if (!this.#button) {
            this.#button = this.#create();
        }

        if (this.#button.previousElementSibling !== anchor) {
            anchor.after(this.#button);
        }
    }

    #create() {
        // The same classes as its neighbours, so it looks like one. jellyfin-web's focus handling takes any button.
        const button = element(
            'button',
            {type: 'button', class: 'btnYomitan autoSize paper-icon-button-light', on: {click: this.#onClick}},
            element('span', {class: 'xlargePaperIconButton material-icons translate', 'aria-hidden': 'true'}),
        );
        this.#button = button;
        this.#render();
        return button;
    }

    #onClick = () => {
        this.#settings.set('enabled', !this.#settings.get('enabled'));
        // Whoever presses it has found it.
        this.#settings.set('introSeen', true);
        this.#closeIntro?.();
    };

    /**
     * The first time this user plays a track the button is for, with the feature off, a notice says what it is. See
     * settings-page/intro.js. It does not pause, and if anything goes wrong it just does not show.
     */
    #introduce() {
        const settings = this.#settings;
        const due = () => this.#button?.isConnected && !settings.get('enabled') && !settings.get('introSeen');
        if (this.#introduced || !due()) {
            return;
        }

        this.#introduced = true;
        // A device that has not seen this user before only has the defaults until the server answers.
        settings.refresh()
            .then(() => due() && this.#loadSettingsPage())
            .then((intro) => {
                if (intro && due()) {
                    this.#closeIntro = intro.showIntro(settings, showNotice);
                }
            })
            .catch((error) => console.debug('[yomitan] no notice:', error));
    }

    #render() {
        if (!this.#button) {
            return;
        }

        const button = this.#button;
        const enabled = this.#settings.get('enabled');
        const label = `Yomitan lookups: ${enabled ? 'on' : 'off'}${this.#problem ? `, not working. ${this.#problem}` : ''}`;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', `${enabled}`);
        if (enabled) {
            button.style.color = this.#problem ? PROBLEM_COLOR : ON_COLOR;
        } else {
            button.style.removeProperty('color');
        }
    }

    #remove() {
        this.#button?.remove();
        this.#button = null;
        // It is about this button and these subtitles.
        this.#closeIntro?.();
    }

    #stop() {
        clearInterval(this.#timer);
        this.#timer = 0;
        this.#forgetTrack(null);
        this.#remove();
    }

    /** Drops what was worked out for the last track, including a decision still on its way. */
    #forgetTrack(key) {
        this.#trackKey = key;
        this.#applies = false;
        this.#problem = null;
        this.#decision?.abort();
        this.#decision = null;
    }
}
