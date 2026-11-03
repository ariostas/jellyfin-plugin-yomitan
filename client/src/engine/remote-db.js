// What Yomitan's Translator needs of a DictionaryDatabase, over the plugin's HTTP API. See docs/api.md.

const titlesOf = (dictionaries) => [...dictionaries.keys()];

export class RemoteDb {
    /**
     * @param {import('./query-client.js').QueryClient} client
     * @param {import('./term-store.js').TermStore} terms
     */
    constructor(client, terms) {
        this._client = client;
        this._terms = terms;
        /** Counts answers that came back cut short, so a lookup can tell whether its result is whole. */
        this.truncations = 0;
    }

    async _call(operation) {
        const [{rows, truncated}] = await this._client.send([operation]);
        this.truncations += truncated ? 1 : 0;
        return rows;
    }

    async findTermsBulk(termList, dictionaries, matchType) {
        if (termList.length === 0) {
            return [];
        }

        if (matchType !== 'exact') {
            return this._call({op: 'findTermsBulk', termList, dictionaries: titlesOf(dictionaries), matchType});
        }

        if (!await this._terms.ensure(termList)) {
            this.truncations += 1;
        }

        return this._terms.read(termList);
    }

    findTermsExactBulk(termList, dictionaries) {
        return this._call({op: 'findTermsExactBulk', termList, dictionaries: titlesOf(dictionaries)});
    }

    findTermsBySequenceBulk(items) {
        return items.length ? this._call({op: 'findTermsBySequenceBulk', items}) : [];
    }

    findTermMetaBulk(termList, dictionaries) {
        return termList.length ? this._call({op: 'findTermMetaBulk', termList, dictionaries: titlesOf(dictionaries)}) : [];
    }

    findKanjiBulk(kanjiList, dictionaries) {
        return this._call({op: 'findKanjiBulk', kanjiList, dictionaries: titlesOf(dictionaries)});
    }

    findKanjiMetaBulk(kanjiList, dictionaries) {
        return kanjiList.length ? this._call({op: 'findKanjiMetaBulk', kanjiList, dictionaries: titlesOf(dictionaries)}) : [];
    }

    async findTagMetaBulk(items) {
        if (items.length === 0) {
            return [];
        }

        // Yomitan's method gives undefined for a miss, and the Translator tests for exactly that.
        const rows = await this._call({op: 'findTagMetaBulk', items});
        return rows.map((row) => row ?? undefined);
    }

    async getDictionaryInfo() {
        // Every request carries the list, so an empty one is enough, and a second getDictionaryInfo would only answer
        // within the byte budget.
        if (!this._client.dictionaries) {
            await this._client.send([]);
        }

        return this._client.dictionaries;
    }
}

/** Stands in for the database while planning: it records what the Translator would ask for, and finds nothing. */
export class RecordingDb {
    constructor() {
        this.terms = new Set();
    }

    findTermsBulk(termList) {
        for (const term of termList) {
            this.terms.add(term);
        }

        return [];
    }
}
