// Real frequency and pitch data, made into dictionaries from openly licensed lists that are not in this repository:
//   ja_50k.txt   FrequencyWords, OpenSubtitles 2016, CC BY-SA 4.0. github.com/hermitdave/FrequencyWords
//   accents.txt  Kanjium, CC BY-SA 4.0. github.com/mifunetoshiro/kanjium
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {makeZip} from './zip.mjs';

const BANK_SIZE = 10_000;

function dictionary(title, frequencyMode, rows) {
    const banks = [];
    for (let start = 0; start < rows.length; start += BANK_SIZE) {
        banks.push({
            name: `term_meta_bank_${banks.length + 1}.json`,
            data: Buffer.from(JSON.stringify(rows.slice(start, start + BANK_SIZE))),
        });
    }

    const index = {title, format: 3, revision: '1', sequenced: false, ...frequencyMode};
    return makeZip([{name: 'index.json', data: Buffer.from(JSON.stringify(index))}, ...banks]);
}

export function makeFrequencyDictionary(directory) {
    const path = join(directory, 'ja_50k.txt');
    if (!existsSync(path)) {
        return null;
    }

    const rows = readFileSync(path, 'utf8').trim().split('\n').map((line, rank) => [line.split(' ')[0], 'freq', rank + 1]);
    return dictionary('FrequencyWords', {frequencyMode: 'rank-based'}, rows);
}

export function makePitchDictionary(directory) {
    const path = join(directory, 'accents.txt');
    if (!existsSync(path)) {
        return null;
    }

    const rows = readFileSync(path, 'utf8').trim().split('\n').flatMap((line) => {
        const [term, reading, positions] = line.split('\t');
        const pitches = (positions ?? '').split(',').filter((position) => /^\d+$/.test(position)).map((position) => ({position: Number(position)}));
        return pitches.length > 0 ? [[term, 'pitch', {reading: reading || term, pitches}]] : [];
    });
    return dictionary('Kanjium', {}, rows);
}
