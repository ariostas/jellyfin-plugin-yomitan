// Talks to POST /Yomitan/Query. Every request also carries getDictionaryInfo, which runs in the same read transaction,
// so a replaced dictionary shows up in the very response that first uses it.

export class QueryError extends Error {}

/** Waits between attempts. Long enough for a phone to change networks, short enough to give the line back soon. */
const RETRY_DELAYS_MS = [500, 1500];
/**
 * A request still unanswered after this is given up. The server stops itself at 5 s, so this is a stalled connection
 * or a server in trouble, and everything after it waits in line meanwhile.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A timeout is not retried: a request that has had 15 s already would hold up every line behind it for 45 s more, and a
 * network that drops shows up as a TypeError at once.
 */
function shouldRetry(error) {
    return error instanceof TypeError || (error instanceof QueryError && error.status >= 500);
}

/**
 * @param {AbortSignal} [signal] The caller's.
 * @returns {{signal: AbortSignal, done: () => void}} A signal that also aborts at the timeout, and how to let it go.
 */
function withTimeout(signal) {
    // AbortSignal.any would do this, but it is newer than some of the TVs jellyfin-web runs on.
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    const timer = setTimeout(() => {
        controller.abort(new DOMException(`Yomitan/Query had no answer in ${REQUEST_TIMEOUT_MS / 1000} s`, 'TimeoutError'));
    }, REQUEST_TIMEOUT_MS);
    if (signal?.aborted) {
        abort();
    }

    signal?.addEventListener('abort', abort, {once: true});
    return {
        signal: controller.signal,
        done: () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        },
    };
}

/** Waits, unless the caller gives up first. */
function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        if (signal?.aborted) {
            onAbort();
        } else {
            signal?.addEventListener('abort', onAbort, {once: true});
        }
    });
}

function signature(dictionaries) {
    return JSON.stringify(dictionaries.map(({title, importDate}) => [title, importDate]));
}

export class QueryClient {
    /** @param {(dictionaries: object[]) => void} onDictionariesChanged Called before the response that noticed. */
    constructor(onDictionariesChanged) {
        this._onDictionariesChanged = onDictionariesChanged;
        this.requests = 0;
        this._signature = null;
    }

    /** @param {object} apiClient jellyfin-web's ApiClient. */
    bind(apiClient) {
        this._apiClient = apiClient;
    }

    /**
     * @param {object[]} operations
     * @param {object} [options]
     * @param {AbortSignal} [options.signal] Gives up on the request, and on any retry still to come.
     * @returns {Promise<{rows: object[], truncated: boolean}[]>} One result per operation.
     * @throws {QueryError} On any answer but 200, once server errors have been retried.
     * @throws {TypeError} If the network stays down through the retries.
     * @throws {DOMException} A `TimeoutError` after 15 s with no answer, or the signal's reason once it aborts.
     */
    async send(operations, {signal} = {}) {
        const body = JSON.stringify({operations: [...operations, {op: 'getDictionaryInfo'}]});
        for (const wait of RETRY_DELAYS_MS) {
            try {
                return await this._post(body, signal);
            } catch (error) {
                if (!shouldRetry(error)) {
                    throw error;
                }
            }

            await delay(wait, signal);
        }

        return this._post(body, signal);
    }

    async _post(body, callerSignal) {
        const apiClient = this._apiClient;
        this.requests += 1;
        const {signal, done} = withTimeout(callerSignal);
        let results;
        try {
            const response = await fetch(apiClient.getUrl('Yomitan/Query'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `MediaBrowser Token="${apiClient.accessToken()}"`,
                },
                body,
                signal,
            });
            if (!response.ok) {
                const error = new QueryError(`Yomitan/Query returned ${response.status}`);
                error.status = response.status;
                throw error;
            }

            ({results} = await response.json());
        } catch (error) {
            // Safari rejects with a plain AbortError whatever the reason, and a timeout must not pass for a session
            // that ended, which fails nothing.
            throw signal.aborted ? signal.reason : error;
        } finally {
            done();
        }

        const {rows: dictionaries} = results.at(-1);
        const current = signature(dictionaries);
        if (this._signature !== current) {
            const changed = this._signature !== null;
            this._signature = current;
            if (changed) {
                this._onDictionariesChanged(dictionaries);
            }
        }

        this.dictionaries = dictionaries;
        return results.slice(0, -1);
    }
}
