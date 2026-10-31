// Runs real Yomitan in a Chromium page: real IndexedDB, and the real image loader, which decodes with <img>.
import {server} from './jellyfin.mjs';
import {bundleYomitan} from './yomitan.mjs';

const origin = 'https://yomitan.test';

/** Opens a page with an empty real DictionaryDatabase. */
export async function openYomitan(browser) {
    const script = await bundleYomitan();
    const context = await browser.newContext();
    const page = await context.newPage();

    // The database starts a Worker for drawMedia, which is not under test and has no script here.
    await page.addInitScript(() => {
        window.Worker = class {
            addEventListener() {}

            postMessage() {}

            terminate() {}
        };
    });

    const archives = new Map();
    await page.route(`${origin}/**`, (route) => {
        const {pathname} = new URL(route.request().url());
        if (pathname === '/') {
            return route.fulfill({contentType: 'text/html', body: '<!doctype html><title>yomitan</title>'});
        }

        return route.fulfill({contentType: 'application/zip', body: archives.get(pathname)});
    });

    await page.goto(`${origin}/`);
    await page.addScriptTag({content: script});
    await page.evaluate(async () => {
        const {DictionaryDatabase} = window.yomitan;
        window.database = new DictionaryDatabase();
        await window.database.prepare();
    });

    return {
        page,
        context,

        /** Imports an archive as the extension does, with suffix search support on. */
        async importDictionary(name, archive) {
            archives.set(`/${name}.zip`, archive);
            return page.evaluate(async (url) => {
                const {DictionaryImporter, DictionaryImporterMediaLoader} = window.yomitan;
                const content = await (await fetch(url)).arrayBuffer();
                const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
                const {result, errors} = await importer.importDictionary(window.database, content, {prefixWildcardsSupported: true, yomitanVersion: '0.0.0.0'});
                return {result, errors: errors.map(String)};
            }, `/${name}.zip`);
        },

        /** Runs operations in the batch format against the real database. undefined becomes null, as in JSON. */
        run(operations) {
            return page.evaluate(async (list) => {
                const results = [];
                for (const {op, termList, kanjiList, items, dictionaries, matchType} of list) {
                    const set = new Set(dictionaries);
                    const db = window.database;
                    const rows = await {
                        findTermsBulk: () => db.findTermsBulk(termList, set, matchType),
                        findTermsExactBulk: () => db.findTermsExactBulk(termList, set),
                        findTermsBySequenceBulk: () => db.findTermsBySequenceBulk(items),
                        findTermMetaBulk: () => db.findTermMetaBulk(termList, set),
                        findKanjiBulk: () => db.findKanjiBulk(kanjiList, set),
                        findKanjiMetaBulk: () => db.findKanjiMetaBulk(kanjiList, set),
                        findTagMetaBulk: () => db.findTagMetaBulk(items),
                        getDictionaryInfo: () => db.getDictionaryInfo(),
                    }[op]();
                    results.push(Array.from(rows, (row) => row ?? null));
                }

                return results;
            }, operations);
        },

        /**
         * Runs the same Translator calls against the real database and against the server, through a stand-in
         * for Phase 3's adapter, and returns both results as JSON text.
         */
        async translate(calls, query) {
            await page.exposeFunction('queryServer', query);
            return page.evaluate(async (list) => {
                const {Translator} = window.yomitan;
                const remote = {
                    async call(operation) {
                        const [{rows, truncated}] = await window.queryServer([operation]);
                        if (truncated) {
                            throw new Error('A parity query was cut short');
                        }

                        return rows;
                    },
                    findTermsBulk(termList, set, matchType) {
                        return this.call({op: 'findTermsBulk', termList, dictionaries: [...set.keys()], matchType});
                    },
                    findTermsExactBulk(termList, set) {
                        return this.call({op: 'findTermsExactBulk', termList, dictionaries: [...set.keys()]});
                    },
                    findTermsBySequenceBulk(items) {
                        return this.call({op: 'findTermsBySequenceBulk', items});
                    },
                    findTermMetaBulk(termList, set) {
                        return this.call({op: 'findTermMetaBulk', termList, dictionaries: [...set.keys()]});
                    },
                    findKanjiBulk(kanjiList, set) {
                        return this.call({op: 'findKanjiBulk', kanjiList, dictionaries: [...set.keys()]});
                    },
                    findKanjiMetaBulk(kanjiList, set) {
                        return this.call({op: 'findKanjiMetaBulk', kanjiList, dictionaries: [...set.keys()]});
                    },
                    async findTagMetaBulk(items) {
                        const rows = await this.call({op: 'findTagMetaBulk', items});
                        return rows.map((row) => row ?? undefined);
                    },
                    getDictionaryInfo() {
                        return this.call({op: 'getDictionaryInfo'});
                    },
                };

                const translators = [new Translator(window.database), new Translator(remote)];
                for (const translator of translators) {
                    translator.prepare();
                }

                const run = (translator, {func, mode, text, options}) => (func === 'findTerms'
                    ? translator.findTerms(mode, text, window.yomitan[options.create](...options.args))
                    : translator.findKanji(text, window.yomitan[options.create](...options.args)));

                const output = [];
                for (const call of list) {
                    output.push({
                        name: call.name,
                        real: JSON.stringify(await run(translators[0], call)),
                        served: JSON.stringify(await run(translators[1], call)),
                    });
                }

                return output;
            }, calls);
        },
    };
}

