// Builds the two scripts the plugin serves: client.js, the small loader on every page, and engine.js, which the
// loader fetches when a video starts. Set YOMITAN_FULL_ENGINE=1 to keep every language, for comparing sizes.
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {build} from 'esbuild';

const yomitan = new URL('../third_party/yomitan/', import.meta.url).pathname;
const {version} = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));

const licenseBanner = `/*
 * Jellyfin Yomitan client. Copyright (C) the Jellyfin Yomitan contributors. GPL-3.0.
 * Bundles Yomitan's language code, Copyright (C) 2023-2026 Yomitan Authors, Copyright (C) 2019-2022 Yomichan
 * Authors, under the GNU General Public License version 3 or later. See https://github.com/yomidevs/yomitan.
 * This program comes with ABSOLUTELY NO WARRANTY. Source: third_party/yomitan in the plugin's repository.
 * Bundles kanji-processor, Copyright (c) 2024 Lyroxide, under the MIT License.
 */`;

// Yomitan's own build generates ext/lib, so these lines do what its dev/lib directory does.
const generated = {
    'kanji-processor.js': "export * from 'kanji-processor';",
    'hangul-js.js': "export * as Hangul from 'hangul-js';",
};

const yomitanLibs = {
    name: 'yomitan-libs',
    setup(context) {
        context.onResolve({filter: /\/lib\/[\w-]+\.js$/}, ({path, importer}) => {
            const name = path.slice(path.lastIndexOf('/') + 1);
            return importer.startsWith(yomitan) && generated[name] ? {path: name, namespace: 'yomitan-lib'} : undefined;
        });
        context.onLoad({filter: /.*/, namespace: 'yomitan-lib'}, ({path}) => ({
            contents: generated[path],
            resolveDir: import.meta.dirname,
            loader: 'js',
        }));
    },
};

// Every other language hangs off this one module, so replacing it is what trims the bundle. The submodule stays as
// it is. tests/e2e/engine.spec.mjs checks the result against the untrimmed Translator.
const japaneseOnly = {
    name: 'japanese-only',
    setup(context) {
        context.onResolve({filter: /\/language-descriptors\.js$/}, ({importer}) => (
            importer === join(yomitan, 'ext/js/language/languages.js') ?
                {path: join(import.meta.dirname, 'src/engine/language-descriptors.js')} :
                undefined
        ));
    },
};

async function writeBundle({path, contents}) {
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, contents);
}

const common = {
    absWorkingDir: import.meta.dirname,
    bundle: true,
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
};

const engine = await build({
    ...common,
    entryPoints: ['src/engine-entry.js'],
    outfile: 'dist/engine.js',
    format: 'esm',
    banner: {js: licenseBanner},
    plugins: process.env.YOMITAN_FULL_ENGINE === '1' ? [yomitanLibs] : [yomitanLibs, japaneseOnly],
    define: {__CLIENT_VERSION__: JSON.stringify(version)},
    write: false,
});
await writeBundle(engine.outputFiles[0]);

// The same hash the server serves the file under, so a new engine is a new URL.
const engineVersion = createHash('sha256').update(engine.outputFiles[0].contents).digest('hex').slice(0, 16);

const client = await build({
    ...common,
    entryPoints: ['src/main.js'],
    outfile: 'dist/client.js',
    format: 'iife',
    define: {__CLIENT_VERSION__: JSON.stringify(version), __ENGINE_VERSION__: JSON.stringify(engineVersion)},
    write: false,
});
await writeBundle(client.outputFiles[0]);
