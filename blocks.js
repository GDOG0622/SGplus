/**
 * Shared block model for both preset entries and regex scripts.
 *
 * A group is nothing more than a contiguous run inside SillyTavern's own
 * ordered array. Its position is wherever its first member sits, so the host
 * array stays the single source of truth: remove this extension and the order
 * survives untouched, only the grouping is lost.
 *
 * @template T
 * @param {object} options
 * @param {T[]} options.items the host's ordered array
 * @param {(item: T) => string} options.idOf reads an item's stable id
 * @param {Record<string, string>} options.assignments item id to group id
 * @param {{id: string}[]} options.groups group definitions, used for empty groups
 * @returns {{type: 'item'|'group', id: string, group: object|null, members: T[]}[]}
 */
export function buildBlocks({ items, idOf, assignments, groups }) {
    const blocks = [];
    const emitted = new Set();
    const membersByGroup = new Map();
    const groupById = new Map(groups.map(group => [group.id, group]));

    for (const item of items) {
        const id = idOf(item);
        if (!id) continue;
        const groupId = assignments[id];
        if (!groupId || !groupById.has(groupId)) continue;
        if (!membersByGroup.has(groupId)) membersByGroup.set(groupId, []);
        membersByGroup.get(groupId).push(item);
    }

    for (const item of items) {
        const id = idOf(item);
        if (!id) continue;
        const groupId = assignments[id];
        const group = groupId ? groupById.get(groupId) : null;
        if (!group) {
            blocks.push({ type: 'item', id, group: null, members: [item] });
            continue;
        }
        if (emitted.has(group.id)) continue;
        emitted.add(group.id);
        blocks.push({ type: 'group', id: group.id, group, members: membersByGroup.get(group.id) || [] });
    }

    for (const group of groups) {
        if (emitted.has(group.id)) continue;
        blocks.push({ type: 'group', id: group.id, group, members: [] });
    }
    return blocks;
}

/**
 * Rewrites the host array so every group's members sit together.
 * @returns {boolean} whether the order actually changed
 */
export function applyBlocks(blocks, items) {
    const next = [];
    for (const block of blocks) next.push(...block.members);
    // Refuse to touch the host array if we would add or lose an entry.
    if (next.length !== items.length) return false;
    const changed = next.some((item, index) => item !== items[index]);
    if (!changed) return false;
    items.splice(0, items.length, ...next);
    return true;
}

/** Swaps a whole block (a loose item or an entire group) with its neighbour. */
export function moveBlockBy(blocks, blockId, delta) {
    const index = blocks.findIndex(block => block.id === blockId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= blocks.length) return null;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

/** Drops a block before or after another block. */
export function placeBlockAt(blocks, sourceId, targetId, placeAfter = false) {
    if (!sourceId || sourceId === targetId) return null;
    const next = [...blocks];
    const sourceIndex = next.findIndex(block => block.id === sourceId);
    if (sourceIndex < 0) return null;
    const [block] = next.splice(sourceIndex, 1);
    if (!targetId) {
        next.push(block);
        return next;
    }
    const targetIndex = next.findIndex(item => item.id === targetId);
    if (targetIndex < 0) return null;
    next.splice(targetIndex + (placeAfter ? 1 : 0), 0, block);
    return next;
}
