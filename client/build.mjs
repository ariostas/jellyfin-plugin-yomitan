// Builds the scripts the plugin serves: client.js, the small loader on every page, engine.js, which the loader fetches when
// a video starts, settings-page.js, which it fetches when someone opens their settings, and admin.js for the dashboard. Set YOMITAN_FULL_ENGINE=1 to keep every language, for comparing sizes.
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {build} from 'esbuild';
import {displayCss} from './display-css.mjs';

const yomitan = new URL('../third_party/yomitan/', import.meta.url).pathname;
const version = (await readFile(new URL('../VERSION', import.meta.url), 'utf8')).trim();

// The npm packages that may end up in a bundle, each with its notice in THIRD-PARTY-NOTICES.md. The build fails on any
// other, so a new one cannot ship without its license.
const noticedPackages = new Set(['kanji-processor']);

// What each script may weigh gzipped, in KB, since that is about what crosses the network. The loader is on every page of
// jellyfin-web, and the engine starts every video. tests/e2e/injection.spec.mjs checks what the server sends. The loader's
// is about 7% over what it weighs, so that something it needs fits and anything that could wait for a video or the
// settings page goes to them instead.
const budgets = {'client.js': 5, 'engine.js': 110, 'settings-page.js': 6, 'admin.js': 5};

const licenseBanner = `/*
 * Jellyfin Yomitan client. Copyright (C) the Jellyfin Yomitan contributors. GPL-3.0.
 * Bundles Yomitan's language and display code, its display templates, stylesheets and icons, Copyright (C) 2023-2026
 * Yomitan Authors, Copyright (C) 2016-2022 Yomichan Authors, under the GNU General Public License version 3 or later.
 * See https://github.com/yomidevs/yomitan.
 * This program comes with ABSOLUTELY NO WARRANTY. Source: https://github.com/ariostas/jellyfin-plugin-yomitan, with Yomitan in
 * third_party/yomitan. Bundles kanji-processor, Copyright (c) 2024 Lyroxide, under the MIT License. See
 * THIRD-PARTY-NOTICES.md there.
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

// Yomitan's templates and CSS, from the submodule. Text in the bundle, because an extension's files are not here to fetch.
const popupAssets = {
    name: 'popup-assets',
    setup(context) {
        const assets = {
            'yomitan-assets:templates': () => readFile(join(yomitan, 'ext/templates-display.html'), 'utf8'),
            'yomitan-assets:css': () => displayCss(join(yomitan, 'ext')),
        };
        context.onResolve({filter: /^yomitan-assets:/}, ({path}) => ({path, namespace: 'popup-assets'}));
        context.onLoad({filter: /.*/, namespace: 'popup-assets'}, async ({path}) => ({contents: await assets[path](), loader: 'text'}));
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
    metafile: true,
};

const engine = await build({
    ...common,
    entryPoints: ['src/engine-entry.js'],
    outfile: 'dist/engine.js',
    format: 'esm',
    banner: {js: licenseBanner},
    plugins: process.env.YOMITAN_FULL_ENGINE === '1' ? [yomitanLibs, popupAssets] : [yomitanLibs, japaneseOnly, popupAssets],
    define: {__CLIENT_VERSION__: JSON.stringify(version)},
    write: false,
});
await writeBundle(engine.outputFiles[0]);

// The same hash the server serves each file under, so a new build is a new URL.
const contentVersion = ({contents}) => createHash('sha256').update(contents).digest('hex').slice(0, 16);

const settingsPage = await build({
    ...common,
    entryPoints: ['src/settings-page/entry.js'],
    outfile: 'dist/settings-page.js',
    format: 'esm',
    write: false,
});
await writeBundle(settingsPage.outputFiles[0]);

// jellyfin-web imports this one itself, through its route for a plugin's pages.
const admin = await build({
    ...common,
    entryPoints: ['src/admin/entry.js'],
    outfile: 'dist/admin.js',
    format: 'esm',
});

const client = await build({
    ...common,
    entryPoints: ['src/main.js'],
    outfile: 'dist/client.js',
    format: 'iife',
    define: {
        __CLIENT_VERSION__: JSON.stringify(version),
        __ENGINE_VERSION__: JSON.stringify(contentVersion(engine.outputFiles[0])),
        __SETTINGS_PAGE_VERSION__: JSON.stringify(contentVersion(settingsPage.outputFiles[0])),
    },
    write: false,
});
await writeBundle(client.outputFiles[0]);

const bundled = new Set([engine, settingsPage, admin, client].flatMap(({metafile}) => Object.keys(metafile.inputs))
    .map((input) => input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1])
    .filter(Boolean));
const unnoticed = [...bundled].filter((name) => !noticedPackages.has(name));
if (unnoticed.length > 0) {
    throw new Error(`Bundled without a notice in THIRD-PARTY-NOTICES.md: ${unnoticed.join(', ')}`);
}

const sizes = await Promise.all(Object.entries(budgets).map(async ([name, budget]) => {
    const kb = gzipSync(await readFile(join(import.meta.dirname, 'dist', name))).length / 1024;
    return {name, kb, budget};
}));
console.log(`Bundles, gzipped: ${sizes.map(({name, kb, budget}) => `${name} ${kb.toFixed(1)} of ${budget} KB`).join(', ')}`);
const over = sizes.filter(({kb, budget}) => kb > budget);
if (over.length > 0) {
    throw new Error(`Over budget: ${over.map(({name}) => name).join(', ')}`);
}
