// The dashboard page's script. jellyfin-web imports this through its route for a plugin's pages, and calls the default
// export with the page's element, so it runs under any BaseUrl, and as the admin who is signed in.
//
// Everything a dictionary says about itself is untrusted: anyone can write a zip. Titles go on screen as text, and
// nothing here parses a string as markup.
import {element, formatBytes, formatCount, formatSize, installStyle} from '../ui/dom.js';
import {describeError, phaseText} from './messages.js';

const POLL_INTERVAL_MS = 300;

const CSS = `
.yomitan-admin .yomitan-upload { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75em; }
.yomitan-admin .yomitan-upload input { flex: 1 1 16em; min-width: 0; max-width: 100%; }
.yomitan-admin .yomitan-upload button { flex: none; width: auto; margin: 0; }
.yomitan-admin button:disabled { opacity: 0.4; }
.yomitan-admin .yomitan-progress { margin-top: 1em; }
.yomitan-admin .yomitan-progress label { display: block; margin-top: 0.5em; overflow-wrap: anywhere; }
.yomitan-admin .yomitan-progress progress { display: block; width: 100%; height: 0.75em; accent-color: var(--jf-palette-primary-main, #00a4dc); }
.yomitan-admin .yomitan-message { margin-top: 1em; overflow-wrap: anywhere; }
.yomitan-admin .yomitan-message:empty { display: none; }
.yomitan-admin .yomitan-message[data-kind=error] { color: #ff8a80; }
.yomitan-admin .yomitan-message button { width: auto; margin: 0.5em 0.5em 0 0; }
.yomitan-admin .yomitan-dictionary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5em 1em;
    padding: 0.75em 0;
    border-top: 1px solid var(--jf-palette-divider, rgba(255, 255, 255, 0.12));
}
.yomitan-admin .yomitan-dictionary-text { flex: 1 1 14em; min-width: 0; overflow-wrap: anywhere; }
.yomitan-admin .yomitan-dictionary-title { color: var(--jf-palette-text-primary, #fff); }
.yomitan-admin .yomitan-dictionary-facts { font-size: 0.875em; }
.yomitan-admin .yomitan-dictionary-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5em; }
.yomitan-admin .yomitan-dictionary-actions button { width: auto; margin: 0; }
`;

function headers() {
    const headers = {};
    window.ApiClient.setRequestHeaders(headers);
    return headers;
}

async function call(path, init = {}) {
    return fetch(window.ApiClient.getUrl(path), {...init, headers: headers()});
}

/**
 * Sends the file. The browser streams a File from disk, so a body of any size costs no memory here, and only an
 * XMLHttpRequest reports how far along the body is: fetch() has no upload progress.
 * @param {File} file
 * @param {boolean} replace
 * @param {(sent: number, total: number) => void} onProgress
 * @returns {Promise<{status: number, body: object|null}>}
 */
function sendFile(file, replace, onProgress) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', window.ApiClient.getUrl('Yomitan/Dictionaries', replace ? {replace: true} : {}));
        for (const [name, value] of Object.entries(headers())) {
            request.setRequestHeader(name, value);
        }

        request.setRequestHeader('Content-Type', 'application/zip');
        request.upload.addEventListener('progress', ({loaded, total}) => onProgress(loaded, total));
        request.addEventListener('load', () => {
            let body = null;
            try {
                body = JSON.parse(request.responseText);
            } catch {
                // A reverse proxy's error page, or Jellyfin's empty 401 and 403.
            }

            resolve({status: request.status, body});
        });
        request.addEventListener('error', () => reject(new Error('The connection failed')));
        request.addEventListener('abort', () => reject(new Error('The upload was cancelled')));
        request.send(file);
    });
}

async function waitForJob(id, onProgress) {
    for (;;) {
        const response = await call(`Yomitan/Jobs/${id}`);
        if (!response.ok) {
            return {state: 'failed', error: {code: response.status === 404 ? 'job_gone' : 'network'}};
        }

        const job = await response.json();
        onProgress(job);
        if (job.state === 'succeeded' || job.state === 'failed') {
            return job;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

class AdminPage {
    constructor(view) {
        this._view = view;
        this._file = view.querySelector('#yomitanFile');
        this._uploadButton = view.querySelector('#yomitanUpload');
        this._progress = view.querySelector('#yomitanProgress');
        this._transfer = view.querySelector('#yomitanTransfer');
        this._transferText = view.querySelector('#yomitanTransferText');
        this._import = view.querySelector('#yomitanImport');
        this._importText = view.querySelector('#yomitanImportText');
        this._message = view.querySelector('#yomitanMessage');
        this._list = view.querySelector('#yomitanList');
        this._totals = view.querySelector('#yomitanTotals');
        this._busy = false;

        this._file.addEventListener('change', () => this._updateButton());
        this._uploadButton.addEventListener('click', () => this._upload(this._file.files[0], false));
        view.addEventListener('viewshow', () => this.refresh());
    }

    _updateButton() {
        this._uploadButton.disabled = this._busy || this._file.files.length === 0;
    }

    _setBusy(busy) {
        this._busy = busy;
        this._file.disabled = busy;
        this._updateButton();
        for (const button of this._list.querySelectorAll('button')) {
            button.disabled = busy;
        }
    }

    _say(kind, text, ...actions) {
        this._message.dataset.kind = kind;
        this._message.replaceChildren(element('div', {}, text), ...actions);
    }

    async refresh() {
        const response = await call('Yomitan/Dictionaries').catch(() => null);
        if (!response?.ok) {
            this._list.replaceChildren(element('p', {class: 'fieldDescription'}, 'The list could not be loaded. Check that the server is reachable, and reload.'));
            return;
        }

        const {dictionaries, databaseBytes, freeBytes} = await response.json();
        this._list.replaceChildren(...dictionaries.map((dictionary) => this._row(dictionary)));
        if (dictionaries.length === 0) {
            this._list.replaceChildren(element('p', {class: 'fieldDescription'}, 'Nothing is installed yet, so nobody can look anything up.'));
        }

        this._totals.textContent = `${formatBytes(databaseBytes)} on disk, ${formatBytes(freeBytes)} of it free for reuse.`;
    }

    _row({title, sizeBytes, summary}) {
        const counts = summary?.counts ?? {};
        const facts = [
            summary?.revision && `Revision ${summary.revision}`,
            formatSize(sizeBytes),
            formatCount(counts.terms?.total ?? 0, 'word'),
            formatCount(counts.kanji?.total ?? 0, 'kanji', 'kanji'),
            formatCount(counts.termMeta?.total ?? 0, 'word note'),
            formatCount(counts.media?.total ?? 0, 'image'),
        ].filter(Boolean);
        const actions = element('div', {class: 'yomitan-dictionary-actions'});
        const ask = () => actions.replaceChildren(
            element('span', {}, 'Delete this for everyone?'),
            element('button', {
                type: 'button',
                class: 'raised emby-button yomitan-confirm-delete',
                textContent: 'Delete',
                on: {click: () => this._delete(title)},
            }),
            element('button', {type: 'button', class: 'raised emby-button yomitan-cancel-delete', textContent: 'Keep', on: {click: show}}),
        );
        const show = () => actions.replaceChildren(
            element('button', {type: 'button', class: 'raised emby-button yomitan-delete', textContent: 'Delete', 'aria-label': `Delete ${title}`, on: {click: ask}}),
        );

        show();
        return element(
            'div',
            {class: 'yomitan-dictionary'},
            element(
                'div',
                {class: 'yomitan-dictionary-text'},
                element('div', {class: 'yomitan-dictionary-title'}, title),
                element('div', {class: 'yomitan-dictionary-facts fieldDescription'}, facts.join(', ')),
            ),
            actions,
        );
    }

    async _upload(file, replace) {
        if (!file || this._busy) {
            return;
        }

        this._setBusy(true);
        this._say('info', '');
        this._progress.hidden = false;
        this._transfer.value = 0;
        this._import.value = 0;
        this._importText.textContent = 'waiting for the file';
        this._transferText.textContent = `0 of ${formatBytes(file.size)}`;
        try {
            const {status, body} = await sendFile(file, replace, (sent, total) => {
                this._transfer.value = total ? sent / total : 0;
                this._transferText.textContent = `${formatBytes(sent)} of ${formatBytes(total)}`;
            });
            if (status !== 202) {
                this._fail(file, describeError(body?.error?.code ?? `status_${status}`, body?.error?.message), null);
                return;
            }

            this._transfer.value = 1;
            this._transferText.textContent = `${formatBytes(file.size)}, done`;
            const job = await waitForJob(body.id, (current) => {
                this._import.value = current.progress?.fraction ?? 0;
                this._importText.textContent = phaseText(current);
            });
            if (job.state === 'succeeded') {
                this._import.value = 1;
                this._importText.textContent = 'done';
                this._say('info', `${job.result.title} is installed.`);
                this._file.value = '';
            } else {
                this._fail(file, describeError(job.error.code, job.error.message, job.title), job);
            }
        } catch (error) {
            this._fail(file, describeError('network', error.message), null);
        } finally {
            this._setBusy(false);
            await this.refresh();
        }
    }

    _fail(file, text, job) {
        this._progress.hidden = true;
        if (job?.error?.code !== 'already_exists') {
            this._say('error', text);
            return;
        }

        this._say(
            'error',
            text,
            element('button', {
                type: 'button',
                class: 'raised button-submit emby-button yomitan-replace',
                textContent: 'Replace it with this file',
                on: {click: () => this._upload(file, true)},
            }),
            element('button', {
                type: 'button',
                class: 'raised emby-button yomitan-keep',
                textContent: 'Keep what is installed',
                on: {click: () => this._say('info', '')},
            }),
        );
    }

    async _delete(title) {
        this._setBusy(true);
        this._say('info', `Deleting ${title}`);
        try {
            const query = new URLSearchParams({title});
            const response = await call(`Yomitan/Dictionaries?${query}`, {method: 'DELETE'});
            const body = await response.json().catch(() => null);
            if (response.status !== 202) {
                this._say('error', describeError(body?.error?.code ?? `status_${response.status}`, body?.error?.message));
                return;
            }

            const job = await waitForJob(body.id, () => {});
            if (job.state === 'succeeded') {
                this._say('info', `${title} is deleted.`);
            } else {
                this._say('error', describeError(job.error.code, job.error.message));
            }
        } catch (error) {
            this._say('error', describeError('network', error.message));
        } finally {
            this._setBusy(false);
            await this.refresh();
        }
    }
}

export default function (view) {
    installStyle('yomitan-admin-style', CSS);
    const page = new AdminPage(view);
    page.refresh();
}
