// Talks to POST /Yomitan/Query. Every request also carries getDictionaryInfo, which runs in the same read transaction,
// so a replaced dictionary shows up in the very response that first uses it.

export class QueryError extends Error {}

/** Waits between attempts. Long enough for a phone to change networks, short enough to give the line back soon. */
const RETRY_DELAYS_MS = [500, 1500];

function shouldRetry(error) {
    return error instanceof TypeError || (error instanceof QueryError && error.status >= 500);
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
     * @returns {Promise<{rows: object[], truncated: boolean}[]>} One result per operation.
     * @throws {QueryError} On any answer but 200, once server errors have been retried.
     * @throws {TypeError} If the network stays down through the retries.
     */
    async send(operations) {
        const body = JSON.stringify({operations: [...operations, {op: 'getDictionaryInfo'}]});
        for (const delay of RETRY_DELAYS_MS) {
            try {
                return await this._post(body);
            } catch (error) {
                if (!shouldRetry(error)) {
                    throw error;
                }
            }

            await new Promise((resolve) => setTimeout(resolve, delay));
        }

        return this._post(body);
    }

    async _post(body) {
        const apiClient = this._apiClient;
        this.requests += 1;
        const response = await fetch(apiClient.getUrl('Yomitan/Query'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `MediaBrowser Token="${apiClient.accessToken()}"`,
            },
            body,
        });
        if (!response.ok) {
            const error = new QueryError(`Yomitan/Query returned ${response.status}`);
            error.status = response.status;
            throw error;
        }

        const {results} = await response.json();
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
