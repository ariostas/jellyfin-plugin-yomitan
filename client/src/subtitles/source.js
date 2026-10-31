// Fetches a subtitle track's text from the server.
import {parseAss} from './ass.js';
import {buildCues} from './cleanup.js';

const ASS_CODECS = new Set(['ass', 'ssa']);

/**
 * @param {{IsTextSubtitleStream?: boolean, DeliveryMethod?: string}} stream
 * @returns {'text'|'image'|'burned-in'} Only `text` has anything for the plugin to read.
 */
export function trackContent(stream) {
    if (stream.DeliveryMethod === 'Encode') {
        return 'burned-in';
    }

    return stream.IsTextSubtitleStream === false ? 'image' : 'text';
}

async function fetchTrack(apiClient, url, signal) {
    const response = await fetch(apiClient.getUrl(url), {
        headers: {Authorization: `MediaBrowser Token="${apiClient.accessToken()}"`},
        signal,
    });
    if (!response.ok) {
        throw new Error(`${url} returned ${response.status}`);
    }

    return response;
}

async function fetchAssEvents(apiClient, base, codec, signal) {
    const response = await fetchTrack(apiClient, `${base}/Stream.${codec}`, signal);
    return parseAss(await response.text());
}

async function fetchTimedText(apiClient, base, signal) {
    const response = await fetchTrack(apiClient, `${base}/Stream.js`, signal);
    const {TrackEvents: events} = await response.json();
    return events.map(({Text: text, StartPositionTicks: start, EndPositionTicks: end}) => (
        {text, start: start / 1e7, end: end / 1e7}
    ));
}

/**
 * Loads a track as cues. ASS comes as the original script, the same file Jellyfin's own renderer reads, because the
 * flattened form cannot tell signs from dialogue. If that fails, the flattened form still gives usable text.
 * @param {object} options
 * @param {object} options.apiClient
 * @param {string} options.itemId
 * @param {string} options.mediaSourceId
 * @param {{Index: number, Codec?: string}} options.stream
 * @param {AbortSignal} options.signal
 * @returns {Promise<import('./timeline.js').Cue[]>}
 * @throws When the server has no text for the track.
 */
export async function loadCues({apiClient, itemId, mediaSourceId, stream, signal}) {
    const base = `Videos/${itemId}/${mediaSourceId}/Subtitles/${stream.Index}`;
    const codec = (stream.Codec ?? '').toLowerCase();
    if (ASS_CODECS.has(codec)) {
        try {
            const events = await fetchAssEvents(apiClient, base, codec, signal);
            if (events.length) {
                return buildCues(events);
            }
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }

            console.debug(`[yomitan] ${error.message}, falling back to timed text`);
        }
    }

    return buildCues(await fetchTimedText(apiClient, base, signal));
}
