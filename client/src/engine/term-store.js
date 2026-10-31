// A client-side copy of the term index, filled in batches, that answers findTermsBulk as the server would.
//
// A segmenter needs findTermsBulk for dozens of windows of text, and the Translator asks once per window. Sending each
// list separately is what cost the spike 10 round trips a line. Merging them is not simple, because the server keeps
// only the first sighting of a row, so a row found under one term is missing from the answer for another. This store
// therefore indexes every row under both its term and its reading, and replays the server's walk for each list.
// tests/e2e/engine.spec.mjs compares this with the server's own answers.

/** The server's MaxItems is 4096 across a request. */
const MAX_TERMS_PER_REQUEST = 4000;
/** Halving this many times cuts a list to a sixteenth, which fits any budget a healthy server has. */
const MAX_SPLITS = 4;
/**
 * Bounds memory on a phone. A row holds a whole glossary, and a line brings in a few hundred, so this is roughly the
 * last 100 lines. Past this the store starts over, which costs little: finished lines are kept by the segmenter.
 */
const MAX_TERMS = 50_000;
const MAX_ROWS = 30_000;

function addRow(map, key, row) {
    const rows = map.get(key);
    if (!rows) {
        map.set(key, [row]);
        return true;
    }

    if (rows.some(({id}) => id === row.id)) {
        return false;
    }

    rows.push(row);
    rows.sort((a, b) => a.id - b.id);
    return true;
}

export class TermStore {
    /** @param {(terms: string[]) => Promise<{rows: object[], truncated: boolean}>} fetchTerms Sends one request. */
    constructor(fetchTerms) {
        this._fetchTerms = fetchTerms;
        this.clear();
    }

    /** Drops everything for good, until `open`. A request still in flight adds nothing. */
    close() {
        this.closed = true;
        this.clear();
    }

    open() {
        this.closed = false;
    }

    /** Drops everything. Row ids mean nothing once a dictionary has been replaced. */
    clear() {
        this._known = new Set();
        this._byTerm = new Map();
        this._byReading = new Map();
        this._rowCount = 0;
        this.generation = (this.generation ?? 0) + 1;
    }

    /** @returns {{terms: number, rows: number}} */
    get size() {
        return {terms: this._known.size, rows: this._rowCount};
    }

    /**
     * Makes sure the store can answer for `terms`, in as few requests as it can.
     * @param {Iterable<string>} terms
     * @returns {Promise<boolean>} False if the server cut an answer short. Those terms stay unknown, so they are asked
     *   for again next time, and what did arrive still answers for now.
     */
    async ensure(terms) {
        // Before fetching, never after: what is fetched here is about to be read.
        this._startOverIfFull();
        const missing = [...new Set(terms)].filter((term) => !this._known.has(term));
        let complete = true;
        for (let start = 0; start < missing.length; start += MAX_TERMS_PER_REQUEST) {
            complete = await this._fetch(missing.slice(start, start + MAX_TERMS_PER_REQUEST), 0) && complete;
        }

        return complete;
    }

    async _fetch(terms, splits) {
        const {generation} = this;
        const {rows, truncated} = await this._fetchTerms(terms);
        if (generation !== this.generation) {
            // The dictionaries changed under this request, so ask again against the new ones. After a playback has
            // ended there is nobody to ask for.
            return this.closed ? false : this.ensure(terms);
        }

        for (const row of rows) {
            const added = addRow(this._byTerm, row.term, row);
            addRow(this._byReading, row.reading, row);
            this._rowCount += added ? 1 : 0;
        }

        if (!truncated) {
            for (const term of terms) {
                this._known.add(term);
            }

            return true;
        }

        if (terms.length < 2 || splits >= MAX_SPLITS) {
            return false;
        }

        const middle = terms.length >> 1;
        const first = await this._fetch(terms.slice(0, middle), splits + 1);
        const second = await this._fetch(terms.slice(middle), splits + 1);
        return first && second;
    }

    _startOverIfFull() {
        if (this._known.size > MAX_TERMS || this._rowCount > MAX_ROWS) {
            // Not a change of dictionaries, so a request in flight stays valid.
            const {generation} = this;
            this.clear();
            this.generation = generation;
        }
    }

    /**
     * Answers like `POST /Yomitan/Query` with `findTermsBulk` and `matchType: "exact"` for this list on its own.
     * @param {string[]} terms
     * @returns {object[]} Fresh rows, so the Translator can edit them.
     */
    read(terms) {
        const seen = new Set();
        const result = [];
        const collect = (rows, index, matchSource) => {
            for (const row of rows ?? []) {
                if (!seen.has(row.id)) {
                    seen.add(row.id);
                    result.push({...row, index, matchType: 'exact', matchSource});
                }
            }
        };

        terms.forEach((term, index) => {
            collect(this._byTerm.get(term), index, 'term');
            collect(this._byReading.get(term), index, 'reading');
        });
        return result;
    }
}
