// Hides Jellyfin's own rendering of the primary subtitle track, and puts it back. There are three render paths, and
// it is simplest to cover all of them: native cues go through the track's mode, and the rest through CSS, which also
// catches a canvas created after this runs.
//
// The secondary track stays visible in every path: it is textTracks[1] natively, and a separate element in the DOM.

const HIDDEN_ATTRIBUTE = 'data-yomitan-hides-subtitles';
const STYLE_ID = 'yomitan-native-style';
const CSS = `
html[${HIDDEN_ATTRIBUTE}] .videoSubtitlesInner,
html[${HIDDEN_ATTRIBUTE}] .libassjs-canvas,
html[${HIDDEN_ATTRIBUTE}] .libassjs-canvas-parent { visibility: hidden; }
`;

/** Jellyfin's own label for the tracks it manages. Anything else on the element is not ours to touch. */
const MANAGED_TRACK = 'manualTrack';
const PRIMARY_TRACK_INDEX = 0;

export class NativeSubtitles {
    /**
     * @param {HTMLVideoElement} video
     * @param {() => number} getOffset Jellyfin's current subtitle offset in seconds.
     */
    constructor(video, getOffset) {
        this._video = video;
        this._getOffset = getOffset;
        this._hidden = false;
        this._offsetOnCues = 0;
    }

    _primaryTrack() {
        const track = this._video.textTracks[PRIMARY_TRACK_INDEX];
        return track?.label.includes(MANAGED_TRACK) ? track : null;
    }

    /** Reading the offset is what can fail if jellyfin-web changes, and the line has to come back regardless. */
    _offsetShift() {
        try {
            return this._getOffset() - this._offsetOnCues;
        } catch (error) {
            console.warn('[yomitan] cannot read the subtitle offset, so the cues stay where they are:', error);
            return 0;
        }
    }

    hide() {
        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            document.head.append(style);
        }

        document.documentElement.setAttribute(HIDDEN_ATTRIBUTE, '');
        this._hidden = true;
        this._offsetOnCues = this._getOffset();
        this.enforce();
    }

    /** Hides the track again if Jellyfin has just shown it, which happens when its cues finish downloading. */
    enforce() {
        const track = this._primaryTrack();
        if (this._hidden && track?.mode === 'showing') {
            track.mode = 'hidden';
        }
    }

    /**
     * Shows Jellyfin's subtitles again. jellyfin-web only moves the cues of a showing track when the offset changes,
     * but still records the new offset, so cues left hidden through a change have to catch up here.
     */
    restore() {
        if (!this._hidden) {
            return;
        }

        this._hidden = false;
        document.documentElement.removeAttribute(HIDDEN_ATTRIBUTE);
        const track = this._primaryTrack();
        if (track?.mode === 'hidden') {
            const shift = this._offsetShift();
            if (shift !== 0) {
                for (const cue of track.cues ?? []) {
                    cue.startTime -= shift;
                    cue.endTime -= shift;
                }
            }

            track.mode = 'showing';
        }
    }
}
