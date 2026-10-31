// Bundles Yomitan's real DictionaryDatabase, DictionaryImporter and Translator for a browser page, from the
// submodule. Yomitan's own build generates ext/lib, so its lines here do what dev/build-libs.js does.
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import {build} from 'esbuild';

const require = createRequire(import.meta.url);
const root = new URL('../../third_party/yomitan/', import.meta.url).pathname;
const outDirectory = new URL('../test-results/yomitan-bundle/', import.meta.url).pathname;

function generateValidators() {
    const directory = join(root, 'ext/data/schemas');
    const schemas = readdirSync(directory).map((file) => JSON.parse(readFileSync(join(directory, file), 'utf8')));
    const ajv = new Ajv({schemas, code: {source: true, esm: true}, allowUnionTypes: true});
    return standaloneCode(ajv);
}

// Worker scripts do not exist in the bundle, so zip.js decompresses on the page.
const zipWrapper = `
    import {configure as configureZip} from '@zip.js/zip.js';
    export * from '@zip.js/zip.js';
    export function configure(options) { configureZip({...options, useWebWorkers: false}); }
`;

const generated = {
    'zip.js': () => zipWrapper,
    'kanji-processor.js': () => "export * from 'kanji-processor';",
    'hangul-js.js': () => "export * as Hangul from 'hangul-js';",
    'validate-schemas.js': generateValidators,
    // Only SVG drawing uses this, and drawMedia is not under test.
    'resvg-wasm.js': () => 'export const initWasm = () => {}; export class Resvg {}',
};

const yomitanLibs = {
    name: 'yomitan-libs',
    setup(context) {
        context.onResolve({filter: /\/lib\/[\w-]+\.js$/}, ({path}) => {
            const name = path.slice(path.lastIndexOf('/') + 1);
            return generated[name] ? {path: name, namespace: 'yomitan-lib'} : undefined;
        });
        context.onLoad({filter: /.*/, namespace: 'yomitan-lib'}, ({path}) => ({
            contents: generated[path](),
            resolveDir: dirname(new URL(import.meta.url).pathname),
            loader: 'js',
        }));
    },
};

/** Returns the script text. It sets window.yomitan to the real classes. */
export async function bundleYomitan() {
    mkdirSync(outDirectory, {recursive: true});
    const entry = join(outDirectory, 'entry.js');
    writeFileSync(entry, `
        export {DictionaryDatabase} from '${root}ext/js/dictionary/dictionary-database.js';
        export {DictionaryImporter} from '${root}ext/js/dictionary/dictionary-importer.js';
        export {DictionaryImporterMediaLoader} from '${root}ext/js/dictionary/dictionary-importer-media-loader.js';
        export {DisplayGenerator} from '${root}ext/js/display/display-generator.js';
        export {Translator} from '${root}ext/js/language/translator.js';
        export {createFindKanjiOptions, createFindTermsOptions} from '${root}test/utilities/translator.js';
    `);
    const result = await build({
        entryPoints: [entry],
        bundle: true,
        format: 'iife',
        globalName: 'yomitan',
        target: 'es2022',
        write: false,
        plugins: [yomitanLibs],
        logLevel: 'warning',
        nodePaths: [join(dirname(require.resolve('@playwright/test/package.json')), '..', '..', 'node_modules')],
    });
    return result.outputFiles[0].text;
}
