// Requests to the server as whoever is signed in, with jellyfin-web's ApiClient for the address and the token. The loader
// and the engine both use these, so there is one way to ask.

/**
 * @param {object} apiClient jellyfin-web's ApiClient.
 * @param {string} path Under the server's address, such as `Yomitan/Settings`.
 * @param {RequestInit & {query?: Record<string, string>}} [init] `query` is the query string.
 * @returns {Promise<Response>}
 */
export function apiFetch(apiClient, path, {query, headers, ...init} = {}) {
    return fetch(apiClient.getUrl(path, query), {
        ...init,
        headers: {...headers, Authorization: `MediaBrowser Token="${apiClient.accessToken()}"`},
    });
}

/**
 * The same, for a caller with nothing to do with an error status but give up.
 * @param {object} apiClient
 * @param {string} path
 * @param {RequestInit & {query?: Record<string, string>}} [init]
 * @returns {Promise<Response>}
 * @throws When the server answers with an error.
 */
export async function apiFetchOk(apiClient, path, init) {
    const response = await apiFetch(apiClient, path, init);
    if (!response.ok) {
        throw new Error(`${path} returned ${response.status}`);
    }

    return response;
}
