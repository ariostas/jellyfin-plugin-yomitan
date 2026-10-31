import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';

const {version} = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));

await build({
    absWorkingDir: import.meta.dirname,
    entryPoints: ['src/main.js'],
    outfile: 'dist/client.js',
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: true,
    define: {__CLIENT_VERSION__: JSON.stringify(version)},
    logLevel: 'warning',
});
