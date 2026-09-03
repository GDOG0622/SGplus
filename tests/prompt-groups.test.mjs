import assert from 'node:assert/strict';
import { setContext } from '../shared.js';
import { buildBlocks, normalizePromptState, readCompatibleState } from '../prompts/state.js';
import { normalizeLibrary } from '../prompts/library.js';
import { normalizeScope } from '../regex/state.js';
import { applyBlocks, buildBlocks as buildBlockModel, moveBlockBy, placeBlockAt } from '../blocks.js';

function withExtensions(extensions) {
    setContext({ chatCompletionSettings: { preset_settings_openai: 'Default', extensions } });
}

// --------------------------------------------------------------- normalization
{
    const state = normalizePromptState(null);
    assert.deepEqual(state.groups, [], 'a missing state must normalize to an empty one');
    assert.deepEqual(state.assignments, {});
    assert.equal('favorites' in state, false, 'favourites were removed and must not come back');
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
    });
    assert.equal(state.groups.length, 2, 'duplicate group ids must collapse into one');
    assert.equal(state.groups[0].name, '世界观', 'group names must be trimmed');
    assert.equal(state.groups[0].collapsed, true, 'groups must default to collapsed');
    assert.equal(state.groups[1].name, '未命名分组', 'blank group names need a fallback');
    assert.equal(state.groups[1].enabled, false, 'an explicit muted flag must survive');
    assert.deepEqual(state.assignments, { one: 'a', two: 'b' }, 'assignments pointing at missing groups must be dropped');
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
        },
    });
    const state = readCompatibleState();
    assert.ok(state, '柏宝箱 metadata must be recognised');
    assert.equal(state.groups.length, 2);
    assert.equal(state.groups[0].name, '角色设定');
    assert.equal(state.groups[0].enabled, false, 'a muted 柏宝箱 group must stay muted');
    assert.equal(state.groups[1].collapsed, true, 'missing collapsed flags default to collapsed');
    assert.deepEqual(state.assignments, { charDescription: 'g1', charPersonality: 'g1' }, 'assignments to unknown groups must be ignored');
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

// -------------------------------------------------------------- global library
{
    const library = normalizeLibrary(null);
    assert.deepEqual(library.items, [], 'a missing library must normalize to an empty one');
    assert.deepEqual(library.groups, []);
    assert.equal(library.collapsed, true, 'the shelf must start collapsed');
}

{
    // The earliest payloads were a bare array of snippets.
    const library = normalizeLibrary([{ id: 'a', name: '片段', content: '正文' }]);
    assert.equal(library.items.length, 1, 'a bare array of items must still import');
    assert.equal(library.items[0].groupId, null);
}

{
    const library = normalizeLibrary({
        groups: [{ id: 'g1', name: '常用' }, { id: 'g1', name: '重复应丢弃' }],
        items: [
            { id: 'i1', name: '  开场  ', content: 'hello', groupId: 'g1' },
            { id: 'i1', name: '重复 id 应重新编号', content: 'x', groupId: 'g1' },
            { id: 'i3', name: '', content: 42, groupId: 'missing' },
        ],
    });
    assert.equal(library.groups.length, 1, 'duplicate library group ids must collapse');
    assert.equal(library.items.length, 3, 'items must be kept even when their id collides');
    assert.notEqual(library.items[0].id, library.items[1].id, 'colliding item ids must be reassigned');
    assert.equal(library.items[0].name, '开场', 'snippet names must be trimmed');
    assert.equal(library.items[2].name, '未命名条目', 'a blank snippet name needs a fallback');
    assert.equal(library.items[2].content, '42', 'non-string bodies must be coerced to text');
    assert.equal(library.items[2].groupId, null, 'a snippet pointing at a missing folder falls back to ungrouped');
}

// ------------------------------------------------------------ regex group scope
{
    const scope = normalizeScope({
        groups: [{ id: 'r1', name: '  思维链  ' }, { id: 'r1', name: '重复应丢弃' }, { id: 'r2', name: '' }],
        assignments: { a: 'r1', b: 'r2', c: 'gone' },
    });
    assert.equal(scope.groups.length, 2, 'duplicate regex group ids must collapse');
    assert.equal(scope.groups[0].name, '思维链', 'regex group names must be trimmed');
    assert.equal(scope.groups[1].name, '未命名分组');
    assert.equal(scope.groups[0].collapsed, true, 'regex groups must default to collapsed');
    assert.deepEqual(scope.assignments, { a: 'r1', b: 'r2' }, 'assignments to missing groups must be dropped');
}

{
    assert.deepEqual(normalizeScope(null), { groups: [], assignments: {} }, 'a missing scope must normalize to an empty one');
}

// ------------------------------------------------- shared block model utilities
{
    // The same model drives both grouping layers, so exercise it on regex-shaped
    // items too: an id lives on `id` rather than `identifier`.
    const scripts = ['a', 'b', 'c', 'd'].map(id => ({ id, scriptName: id }));
    const groups = [{ id: 'g1', name: '一组' }];
    const assignments = { b: 'g1', d: 'g1' };
    const blocks = buildBlockModel({ items: scripts, idOf: script => script.id, assignments, groups });
    assert.deepEqual(blocks.map(block => block.id), ['a', 'g1', 'c'], 'a regex group sits where its first member sits');

    assert.equal(applyBlocks(blocks, scripts), true, 'applying blocks must rewrite the host array');
    assert.deepEqual(scripts.map(script => script.id), ['a', 'b', 'd', 'c'], 'group members must become contiguous');
    assert.equal(applyBlocks(blocks, scripts), false, 'a second apply must be a no-op');

    const moved = moveBlockBy(blocks, 'g1', -1);
    assert.deepEqual(moved.map(block => block.id), ['g1', 'a', 'c'], 'a block must be able to move up');
    assert.equal(moveBlockBy(blocks, 'g1', -5), null, 'moving past the edge must be refused');
    assert.equal(moveBlockBy(blocks, 'missing', 1), null, 'moving an unknown block must be refused');

    const placed = placeBlockAt(blocks, 'a', 'c', true);
    assert.deepEqual(placed.map(block => block.id), ['g1', 'c', 'a'], 'a block must be able to drop after another');
    assert.equal(placeBlockAt(blocks, 'a', 'a'), null, 'dropping a block on itself must be refused');
}

{
    // Refusing to change the item count is what protects the host array from a
    // partial or duplicated write.
    const items = [{ id: 'a' }, { id: 'b' }];
    const bogus = [{ type: 'item', id: 'a', group: null, members: [items[0]] }];
    assert.equal(applyBlocks(bogus, items), false, 'a block set that would lose an item must be rejected');
    assert.deepEqual(items.map(item => item.id), ['a', 'b'], 'the host array must be left untouched');
}

setContext(null);
console.log('prompt-groups.test.mjs: prompt entry, library and regex models verified');
