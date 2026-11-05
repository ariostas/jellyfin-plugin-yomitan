// The term store on its own, with a fake server. engine.spec.mjs runs it against a real one.
import {expect, test} from '@playwright/test';
import {TermStore} from '../../client/src/engine/term-store.js';

const storeWith = async (rows) => {
    const store = new TermStore(async () => ({rows, truncated: false}));
    await store.ensure(['です']);
    return store;
};

test('a row\'s tags are its own, and the codes its structured glossary carries, as Jitendex writes them', async () => {
    const glossary = {type: 'structured-content', content: {tag: 'div', data: {content: 'sense-group'}, content: [
        {tag: 'span', data: {class: 'tag', code: 'exp', content: 'part-of-speech-info'}, content: 'exp'},
        {tag: 'span', data: {class: 'tag', code: 'uk', content: 'misc-info'}, content: 'kana'},
        // An example sentence is not the entry's.
        {tag: 'div', data: {content: 'extra-info'}, content: {tag: 'span', data: {code: 'n', content: 'part-of-speech-info'}}},
    ]}};
    const store = await storeWith([
        {id: 1, term: 'です', reading: 'です', definitionTags: ['★'], termTags: [], definitions: [glossary]},
        {id: 2, term: 'です', reading: 'です', definitionTags: ['cop'], termTags: ['⭐'], definitions: ['to be']},
    ]);
    expect(store.tagsOf(1)).toEqual({definitionTags: ['★', 'exp', 'uk'], termTags: []});
    expect(store.tagsOf(2)).toEqual({definitionTags: ['cop'], termTags: ['⭐']});
    expect(store.tagsOf(3)).toBeUndefined();
});
