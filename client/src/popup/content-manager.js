// What Yomitan's generators call for a dictionary's images and links. Extending this class is what makes
// StructuredContentGenerator hand images over by callback, and draw an <img>. Its other mode draws to a canvas through
// the extension's backend.
import {AnkiTemplateRendererContentManager} from '../../../third_party/yomitan/ext/js/templates/anki-template-renderer-content-manager.js';
import {apiFetchOk} from '../api.js';
import {safeLink} from './sanitize.js';

/** A popup is for reading one word, and this keeps a bad dictionary from asking the server for thousands of files. */
const MAX_IMAGES = 32;

export class ContentManager extends AnkiTemplateRendererContentManager {
    /**
     * @param {object} apiClient jellyfin-web's ApiClient.
     * @param {(query: string) => void} onInternalLink Called with the text of a link to another entry.
     */
    constructor(apiClient, onInternalLink) {
        super(null, null);
        this._apiClient = apiClient;
        this._onInternalLink = onInternalLink;
        this._queue = [];
        this._unloads = [];
        this._urls = new Set();
        this._abort = new AbortController();
    }

    /** Called by the generator, while the entry is still being built, so this only notes it down. See `start`. */
    loadMedia(path, dictionary, onLoad, onUnload) {
        if (this._queue.length < MAX_IMAGES) {
            this._queue.push({path, dictionary, onLoad, onUnload});
        }
    }

    /**
     * Fetches the images. `/Yomitan/Media` needs the Authorization header, which an <img> cannot send, hence the blobs.
     * @param {ParentNode} root Where the images are.
     */
    start(root) {
        const {signal} = this._abort;
        for (const request of this._queue.splice(0)) {
            this._load(request, root, signal).catch((error) => {
                if (error.name !== 'AbortError') {
                    console.debug(`[yomitan] no image for ${request.path}:`, error);
                    request.onUnload(false);
                }
            });
        }
    }

    async _load({path, dictionary, onLoad, onUnload}, root, signal) {
        const response = await apiFetchOk(this._apiClient, 'Yomitan/Media', {query: {dictionary, path}, signal});
        const blob = await response.blob();
        if (signal.aborted) {
            return;
        }

        if (!blob.type.startsWith('image/')) {
            throw new Error(`Not an image: ${blob.type}`);
        }

        const objectUrl = URL.createObjectURL(blob);
        this._urls.add(objectUrl);
        this._unloads.push(onUnload);
        onLoad(objectUrl);

        // The generator also makes the image a link to itself. A blob: URL has this page's origin, so opening a dictionary's
        // SVG in a tab would run its scripts here. An <img> never does.
        for (const link of root.querySelectorAll('a.gloss-image-link[href]')) {
            link.removeAttribute('href');
        }
    }

    /** Drops every image, including those still on their way. */
    unloadAll() {
        this._abort.abort();
        this._abort = new AbortController();
        this._queue = [];
        for (const onUnload of this._unloads.splice(0)) {
            onUnload(true);
        }

        for (const url of this._urls) {
            URL.revokeObjectURL(url);
        }

        this._urls.clear();
    }

    /**
     * @param {HTMLAnchorElement} element
     * @param {string} href
     * @param {boolean} internal Whether it leads to another entry and not a web page.
     */
    prepareLink(element, href, internal) {
        if (internal) {
            const query = new URL(href).searchParams.get('query');
            if (query) {
                element.addEventListener('click', (event) => {
                    event.preventDefault();
                    this._onInternalLink(query);
                });
            }

            return;
        }

        const url = safeLink(href);
        if (url) {
            element.href = url;
            element.target = '_blank';
            element.rel = 'noreferrer noopener';
        }
    }
}
