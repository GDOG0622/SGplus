import assert from 'node:assert/strict';
import { setContext } from '../shared.js';
import { buildBlocks, normalizePromptState, readCompatibleState } from '../prompts/state.js';

function withExtensions(extensions) {
    setContext({ chatCompletionSettings: { preset_settings_openai: 'Default', extensions } });
}

// --------------------------------------------------------------- normalization
{
    const state = normalizePromptState(null);
    assert.deepEqual(state.groups, [], 'a missing state must normalize to an empty one');
    assert.deepEqual(state.assignments, {});
    assert.deepEqual(state.favorites, []);
    assert.equal(state.favoritesCollapsed, false);
}

{
    const state = normalizePromptState({
        groups: [
            { id: 'a', name: '  世界观  ' },
            { id: 'a', name: '重复 id 应被丢弃' },
            { id: 'b', name: '', collapsed: false, enabled: false },
            null,
        ],
        assignments: { one: 'a', two: 'b', orphan: 'missing' },
        favorites: ['one', 'one', '', 'two'],
        favoritesCollapsed: true,
    });
    assert.equal(state.groups.length, 2, 'duplicate group ids must collapse into one');
    assert.equal(state.groups[0].name, '世界观', 'group names must be trimmed');
    assert.equal(state.groups[0].collapsed, true, 'groups must default to collapsed');
    assert.equal(state.groups[1].name, '未命名分组', 'blank group names need a fallback');
    assert.equal(state.groups[1].enabled, false, 'an explicit muted flag must survive');
    assert.deepEqual(state.assignments, { one: 'a', two: 'b' }, 'assignments pointing at missing groups must be dropped');
    assert.deepEqual(state.favorites, ['one', 'two'], 'favourites must be deduped and compacted');
    assert.equal(state.favoritesCollapsed, true);
}

// ------------------------------------------------- 柏宝箱 / legacy compatibility
{
    withExtensions({
        baibaiToolkit: {
            presetPromptGroups: {
                version: 1,
                groups: [
                    { id: 'g1', name: '角色设定', collapsed: false, enabled: false },
                    { id: 'g2', name: '输出格式' },
                ],
                prompts: {
                    charDescription: { groupId: 'g1' },
                    charPersonality: { groupId: 'g1' },
                    main: { groupId: 'nope' },
                },
            },
            presetPromptFavorites: { version: 1, promptIds: ['main', 'chatHistory'], collapsed: true },
        },
    });
    const state = readCompatibleState();
    assert.ok(state, '柏宝箱 metadata must be recognised');
    assert.equal(state.groups.length, 2);
    assert.equal(state.groups[0].name, '角色设定');
    assert.equal(state.groups[0].enabled, false, 'a muted 柏宝箱 group must stay muted');
    assert.equal(state.groups[1].collapsed, true, 'missing collapsed flags default to collapsed');
    assert.deepEqual(state.assignments, { charDescription: 'g1', charPersonality: 'g1' }, 'assignments to unknown groups must be ignored');
    assert.deepEqual(state.favorites, ['main', 'chatHistory']);
    assert.equal(state.favoritesCollapsed, true);
}

{
    withExtensions({
        entryGrouping: {
            groups: [{ id: 1, name: '旧分组' }],
            assignments: { alpha: 1, beta: 1, gamma: 99 },
        },
    });
    const state = readCompatibleState();
    assert.ok(state, 'the older entryGrouping shape must still import');
    assert.equal(state.groups.length, 1);
    assert.equal(state.groups[0].name, '旧分组');
    const groupId = state.groups[0].id;
    assert.deepEqual(state.assignments, { alpha: groupId, beta: groupId });
}

{
    withExtensions({});
    assert.equal(readCompatibleState(), null, 'an empty preset must not invent groups');
}

// ------------------------------------------------------------------ block model
{
    const state = normalizePromptState({
        groups: [{ id: 'g1', name: '一组' }, { id: 'g2', name: '二组' }, { id: 'g3', name: '空组' }],
        assignments: { b: 'g1', d: 'g1', c: 'g2' },
    });
    const order = ['a', 'b', 'c', 'd', 'e'].map(identifier => ({ identifier, enabled: true }));
    const blocks = buildBlocks(state, order);

    assert.deepEqual(
        blocks.map(block => block.id),
        ['a', 'g1', 'g2', 'e', 'g3'],
        'a group must sit where its first member sits, and empty groups go last',
    );
    assert.deepEqual(blocks[1].members.map(entry => entry.identifier), ['b', 'd'], 'group members must be gathered in order');
    assert.equal(blocks[1].type, 'group');
    assert.equal(blocks[0].type, 'item');
    assert.deepEqual(blocks[4].members, [], 'an empty group must still render');

    const flattened = blocks.flatMap(block => block.members.map(entry => entry.identifier));
    assert.deepEqual(flattened, ['a', 'b', 'd', 'c', 'e'], 'flattening blocks must keep every entry exactly once');
    assert.equal(flattened.length, order.length, 'flattening must never drop or duplicate an entry');
}

{
    const state = normalizePromptState({ groups: [], assignments: {} });
    const order = [{ identifier: 'x', enabled: true }, { identifier: 'y', enabled: false }];
    const blocks = buildBlocks(state, order);
    assert.deepEqual(blocks.map(block => block.type), ['item', 'item'], 'with no groups every entry stays a loose block');
}

{
    // A group whose members are scattered must still produce one contiguous block,
    // which is what lets normalizeOrder repair the native order.
    const state = normalizePromptState({
        groups: [{ id: 'g1', name: '散落' }],
        assignments: { a: 'g1', c: 'g1', e: 'g1' },
    });
    const order = ['a', 'b', 'c', 'd', 'e'].map(identifier => ({ identifier, enabled: true }));
    const blocks = buildBlocks(state, order);
    assert.equal(blocks.length, 3, 'scattered members must collapse into a single group block');
    assert.deepEqual(blocks[0].members.map(entry => entry.identifier), ['a', 'c', 'e']);
    assert.deepEqual(blocks.flatMap(block => block.members.map(entry => entry.identifier)), ['a', 'c', 'e', 'b', 'd']);
}

setContext(null);
console.log('prompt-groups.test.mjs: prompt entry grouping model verified');
