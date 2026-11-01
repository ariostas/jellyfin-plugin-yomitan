// The API's error codes and phases, in words for someone running a server. docs/api.md lists them, and
// tests/e2e/contract.spec.mjs checks that every job error here is one the API has.

/** @type {Record<string, string|((title: string|null) => string)>} */
const ERRORS = {
    already_exists: (title) => `A dictionary called ${title ?? 'this'} is already installed. You can replace it, which everyone sees at once.`,
    cancelled: 'The server shut down during this. Nothing changed. Try again.',
    empty_upload: 'The file is empty.',
    incompatible: 'This dictionary needs a newer version of Yomitan than the plugin carries. Look for a plugin update.',
    internal: 'Something went wrong on the server, or its disk is full. Nothing changed, and its log has the details.',
    invalid_archive: 'This is not a readable zip file, or it has two files with one name.',
    invalid_bank: 'This dictionary\'s data is damaged, or not in Yomitan\'s format.',
    invalid_index: 'This dictionary\'s index.json is damaged, or from a format the plugin does not read.',
    invalid_media: 'One of this dictionary\'s images is missing or cannot be read.',
    limit_exceeded: 'This file is over a limit set on the server. The plugin\'s XML configuration can raise it.',
    missing_index: 'This zip has no index.json at its top level, so it is not a Yomitan dictionary. Some downloads wrap the dictionary in a second zip.',
    not_found: 'That dictionary is gone. Someone may have deleted it already.',
    queue_full: 'Too many jobs are waiting. Try again when they are done.',
    unsafe_path: 'This zip has unsafe file names, so it was refused.',
    upload_failed: 'The upload did not finish. Try again.',
    job_gone: 'The server forgot this job, so it probably restarted. The list below shows what is installed.',
    network: 'The server could not be reached. The list below shows what is installed.',
    status_401: 'You are no longer signed in.',
    status_403: 'Only an administrator can do this.',
    status_413: 'This file is over the size limit of the server, or of a proxy in front of it.',
};

/**
 * @param {string} code From the API, or one of the local ones above.
 * @param {string} [detail] The API's own message, which helps if the code is one this does not know.
 * @param {string|null} [title] The dictionary, if it has been read.
 * @returns {string}
 */
export function describeError(code, detail, title = null) {
    const known = ERRORS[code];
    if (typeof known === 'function') {
        return known(title);
    }

    return known ?? `That did not work: ${detail ?? code}.`;
}

const PHASES = {
    reading: 'reading the file',
    replacing: 'removing the old version',
    terms: 'words',
    termMeta: 'word notes',
    kanji: 'kanji',
    kanjiMeta: 'kanji notes',
    tags: 'tags',
    committing: 'saving',
    compacting: 'tidying up',
};

/**
 * @param {{state: string, phase: string|null, title: string|null, progress: {fraction: number, rows: number}}} job
 * @returns {string} What the job is doing now.
 */
export function phaseText({state, phase, title, progress}) {
    if (state === 'queued') {
        return 'waiting its turn';
    }

    const parts = [PHASES[phase] ?? 'starting'];
    if (title) {
        parts.unshift(title);
    }

    if (progress?.rows) {
        parts.push(`${progress.rows.toLocaleString()} rows`);
    }

    return parts.join(', ');
}
