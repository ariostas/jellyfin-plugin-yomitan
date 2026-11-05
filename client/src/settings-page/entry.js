// The settings script, which the loader imports when someone opens their settings, and for the two things the button in
// the player rarely needs: the notice that introduces it, and reading a text track with no language tag to decide on it.
import {isJapaneseTrack} from '../subtitles/language.js';
import {fetchTimedText, trackPath} from '../subtitles/source.js';

export {showIntro} from './intro.js';
export {openSettingsPage} from './page.js';

/**
 * Whether a track whose tag says nothing is Japanese, by its text. One small request, by the same rule the session uses.
 * @param {object} apiClient
 * @param {{itemId: string, mediaSourceId: string, stream: object}} track
 * @param {AbortSignal} signal
 * @returns {Promise<boolean>}
 */
export async function readsAsJapanese(apiClient, {itemId, mediaSourceId, stream}, signal) {
    return isJapaneseTrack(stream, await fetchTimedText(apiClient, trackPath(itemId, mediaSourceId, stream), signal));
}
