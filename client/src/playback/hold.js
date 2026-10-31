// Pauses the video for a lookup, and remembers that it did, because the rest of the plugin only ever resumes what it
// paused. video.pause() and play() go through jellyfin-web's own listeners, so the server stays in step.

export class PlaybackHold {
    /**
     * @param {HTMLVideoElement} video
     * @param {AbortSignal} signal Ends the listener.
     * @param {() => void} onUserPlay Called when the video starts playing and it was not this class that asked.
     */
    constructor(video, signal, onUserPlay) {
        this._video = video;
        this._onUserPlay = onUserPlay;
        this._held = false;
        this._resuming = false;
        video.addEventListener('play', this._onPlay, {signal});
    }

    /** @returns {boolean} Whether the video is paused because of this class. */
    get held() {
        return this._held;
    }

    /** Pauses a playing video. A video that is already paused stays the user's to resume. */
    hold() {
        if (!this._video.paused) {
            this._held = true;
            this._video.pause();
        }
    }

    /** Resumes, if this class was what paused it. */
    release() {
        if (!this._held) {
            return;
        }

        this._held = false;
        this._resuming = true;
        this._video.play().catch((error) => {
            this._resuming = false;
            // Interrupted by a new load, which is not a failure, or refused by the browser, which leaves it paused.
            console.debug('[yomitan] could not resume:', error);
        });
    }

    /** Stops remembering, for when playing is no longer ours to decide. */
    forget() {
        this._held = false;
    }

    _onPlay = () => {
        if (this._resuming) {
            this._resuming = false;
            return;
        }

        this._held = false;
        this._onUserPlay();
    };
}
