// Which dictionaries a user looks words up in, and in what order, from what is installed and what they chose.

/**
 * @template {{title: string}} T
 * @param {T[]} installed In import order.
 * @param {readonly string[]} order Titles as the user ordered them. Any not installed are skipped, without comment.
 * @returns {T[]} Everything installed. What the user never ordered comes last, so a new upload is lowest in priority.
 */
export function orderDictionaries(installed, order) {
    const rank = new Map(order.map((title, index) => [title, index]));
    const rankOf = ({title}) => rank.get(title) ?? order.length;
    // sort() keeps equal items in place, so the unordered ones stay in import order.
    return [...installed].sort((a, b) => rankOf(a) - rankOf(b));
}

/**
 * @template {{title: string}} T
 * @param {T[]} installed In import order.
 * @param {{get: (name: string) => any}} settings
 * @returns {T[]} The ones to use, highest priority first. A dictionary installed after the user last saved is on, or an
 *   admin's new upload would do nothing for anyone who ever opened their settings.
 */
export function chooseDictionaries(installed, settings) {
    const disabled = new Set(settings.get('disabledDictionaries'));
    return orderDictionaries(installed, settings.get('dictionaryOrder')).filter(({title}) => !disabled.has(title));
}

/**
 * @param {{counts?: {terms?: {total?: number}}}} summary
 * @returns {boolean} Whether this dictionary has words. A kanji or frequency dictionary alone cannot split a line.
 */
export function hasTerms({counts}) {
    return (counts?.terms?.total ?? 0) > 0;
}
