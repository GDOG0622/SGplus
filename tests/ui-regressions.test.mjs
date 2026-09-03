import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

const sharedSource = read('shared.js');
const indexSource = read('index.js');
const resourcesSource = read('resources.js');
const hostSource = read('prompts/host.js');
const stateSource = read('prompts/state.js');
const listSource = read('prompts/list.js');
const blocksSource = read('blocks.js');
const regexHostSource = read('regex/host.js');
const regexStateSource = read('regex/state.js');
const regexListSource = read('regex/list.js');
const regexIndexSource = read('regex/index.js');
const librarySource = read('prompts/library.js');
const promptsIndexSource = read('prompts/index.js');
const presetCollapseSource = read('preset-collapse.js');
const styleSource = read('style.css');
const manifest = JSON.parse(read('manifest.json'));
const packageJson = JSON.parse(read('package.json'));

// ------------------------------------------------------------------ versioning
const sourceVersion = sharedSource.match(/const VERSION = '([^']+)'/)?.[1];
assert.equal(sourceVersion, manifest.version, 'shared and manifest versions must match');
assert.equal(sourceVersion, packageJson.version, 'shared and package versions must match');
assert.equal(manifest.js, 'index.js', 'the manifest must point at the module entry point');

// ------------------------------------------- inherited resource-grouping fixes
const openManagerSource = resourcesSource.match(/export function openManager[\s\S]*?\r?\n}\r?\n\r?\nfunction closeManager/)?.[0] || '';
assert.ok(openManagerSource, 'openManager source was not found');
assert.doesNotMatch(openManagerSource, /scrollTop\s*=\s*0/, 'opening the manager must not override current-item positioning');

assert.match(resourcesSource, /mask\.addEventListener\('click'/, 'blank-area closing must wait for a completed click');
assert.doesNotMatch(resourcesSource, /mask\.addEventListener\('pointerdown'/, 'blank-area closing must not intercept a touch scroll');
assert.match(resourcesSource, /removeEventListener\('pointerdown', handleDocumentPointerDown, true\)/, 'global UI listeners must be cleaned up');

assert.match(styleSource, /#srg-manager-mask \.pgm-body \{[\s\S]*?touch-action:\s*pan-y;/, 'manager body must own vertical touch scrolling');
assert.match(styleSource, /#srg-manager-mask \.srg-pin \{\s*display:\s*none;/, 'hidden pin column must stay hidden');
assert.match(styleSource, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(126px, 180px\);/, 'desktop rows must not reserve a ghost pin column');
assert.match(styleSource, /#srg-manager-mask \.pgm-move \{[^\n]*text-align:\s*center !important;/, 'move selectors must keep centered labels');
assert.match(styleSource, /#srg-manager-mask \.srg-manager \{[\s\S]*?font-size:\s*13px;/, 'manager density must not inherit an oversized theme font');
assert.match(styleSource, /#srg-manager-mask \.pgm-preset \{[\s\S]*?min-height:\s*34px;/, 'manager rows must keep compact height');

assert.doesNotMatch(indexSource, /<b><i class="fa-solid fa-layer-group"><\/i>/, 'settings title must not restore the removed icon');
assert.match(resourcesSource, /function scrubMenuEntryIcon\(item\)/, 'menu icon cleanup must survive host-side reinjection');
assert.match(styleSource, /#srg-menu-entry > :not\(\.srg-menu-label\)/, 'menu entry must hide host-injected children');

assert.match(resourcesSource, /classList\.add\('srg-popover-open'\)/, 'opening the quick picker must lock background scrolling');
assert.match(resourcesSource, /classList\.remove\('srg-popover-open'\)/, 'closing the quick picker must unlock background scrolling');
assert.match(styleSource, /#srg-popover \.pgm-quick-list \{[^\n]*overscroll-behavior-y:\s*contain;/, 'quick picker scrolling must not leak to the page');
assert.match(resourcesSource, /popover\.addEventListener\('touchmove',[\s\S]*?passive:\s*false/, 'touch boundary handling must be able to cancel scroll chaining');
assert.match(resourcesSource, /popover\.addEventListener\('touchstart',[\s\S]*?event\.stopPropagation\(\)/, 'touching the picker must not trigger SillyTavern drawer autoclose');
assert.match(resourcesSource, /touchmove'[\s\S]*?event\.stopPropagation\(\)/, 'quick picker touch movement must not reach host swipe handlers');
assert.match(resourcesSource, /horizontalGesture[\s\S]*?event\.preventDefault\(\)/, 'horizontal gestures inside the picker must be blocked');
assert.match(resourcesSource, /\['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'wheel'\]/, 'pointer and synthetic mouse gestures must stay inside the quick picker');
assert.doesNotMatch(resourcesSource, /\['pointerdown'[^]]*'click'\]/, 'picker clicks must still bubble to its delegated selection handlers');

assert.match(resourcesSource, /function handleRootMutations\(mutations\)[\s\S]*?mutations\.some\(mutationNeedsScan\)/, 'the document observer must filter unrelated host mutations');
assert.doesNotMatch(resourcesSource, /new MutationObserver\(scheduleScan\)/, 'every page mutation must not trigger a full adapter scan');
assert.match(resourcesSource, /if \(this\.trigger\.title !== title\) this\.trigger\.title = title;/, 'unchanged trigger titles must not be rewritten');
assert.match(resourcesSource, /if \(labelNode\.textContent !== label\) labelNode\.textContent = label;/, 'unchanged trigger labels must not be rewritten');
assert.doesNotMatch(resourcesSource, /this\.trigger\.innerHTML\s*=/, 'trigger refreshes must not recreate their DOM on every scan');

assert.match(sharedSource, /export function bindSearchInput\(input, onCommit\)/, 'search fields must share IME-safe input handling');
assert.match(sharedSource, /addEventListener\('compositionstart'/, 'search must preserve Chinese IME composition');
assert.match(sharedSource, /addEventListener\('compositionend'/, 'search must commit completed Chinese IME text');
assert.match(sharedSource, /if \(composing \|\| event\.isComposing\) return;/, 'search must not rerender during composition');
assert.match(sharedSource, /setSelectionRange\(start, end\)/, 'search must restore its caret after rerendering');
assert.doesNotMatch(resourcesSource, /querySelector\('\[data-srg-(?:pop|manager)-search\]'\)\?\.focus\(\)/, 'search must not reset the caret to the start');

assert.match(sharedSource, /let hostModalDepth = 0;/, 'host popup interactions must be tracked');
assert.match(resourcesSource, /if \(getHostModalDepth\(\) > 0 \|\| event\.target\?\.closest\?\.\('\.popup, dialog\[open\]'\)\) return;/, 'host popups must not trigger manager outside-click closing');
assert.match(resourcesSource, /const liveState = getResourceState\(adapter\.stateId\);/, 'rename must resolve the latest group state after awaiting input');
assert.match(resourcesSource, /toast\('分组名称已更新', 'success'\);/, 'successful rename must give explicit feedback');

assert.match(sharedSource, /export function isTauriRuntime\(\)/, 'Tauri runtime detection must be explicit');
assert.match(sharedSource, /export function getTauriTopInset\(viewportWidth\)/, 'Tauri titlebar inset must be applied to manager positioning');
assert.match(resourcesSource, /mask\.style\.setProperty\('height', `\$\{Math\.max\(1, height - topInset\)\}px`, 'important'\)/, 'manager height must account for the Tauri top inset');
assert.match(resourcesSource, /mask\.style\.setProperty\('top', `\$\{topInset\}px`, 'important'\)/, 'Tauri top inset must survive responsive !important rules');
assert.doesNotMatch(sharedSource, /viewportWidth <= 700\) return 0/, 'Tauri safe area must also apply to narrow CSS viewports');
assert.match(styleSource, /--srg-tauri-titlebar-height:\s*36px;/, 'Tauri titlebar guard must have a safe default');
assert.match(resourcesSource, /height: calc\(100dvh - var\(--srg-tauri-top-inset, 0px\)\) !important;/, 'mobile manager height must reserve the Tauri safe area');
assert.match(resourcesSource, /max-height: calc\(100dvh - 14px - var\(--srg-tauri-top-inset, 0px\)\) !important;/, 'mobile manager content must fit below the Tauri safe area');

// ------------------------------------------------------- host bridge robustness
assert.doesNotMatch(hostSource, /^import \{[^}]*\} from '(?:\.\.\/){2,}/m, 'SillyTavern internals must not be reached through a static import');
assert.match(hostSource, /await import\(\/\* webpackIgnore: true \*\/ candidate\)/, 'host internals must be loaded dynamically so a failure can degrade');
assert.match(hostSource, /function scriptModuleCandidates\(file\)/, 'the bridge must try several install layouts');
assert.match(hostSource, /url\.pathname\.indexOf\(marker\)/, 'the bridge must derive the host scripts folder from its own URL');
assert.match(hostSource, /console\.error\(`\[\$\{DISPLAY_NAME\}\] 预设条目列表渲染失败，已回退到原生列表`, error\);[\s\S]*?return state\.originals\.renderPromptManagerListItems\(\.\.\.args\);/, 'a render failure must fall back to the native prompt list');
assert.match(hostSource, /if \(state\.renderDepth > 0 \|\| !state\.hooks\?\.isEnabled\(\)\)/, 'the takeover must be re-entrancy safe and feature gated');
assert.match(hostSource, /identifier !== 'main' && state\.hooks\.isSuppressed\(identifier\)/, 'muting a group must keep the main prompt so relative inserts still resolve');
assert.match(hostSource, /export function removePatches\(\)/, 'every patch must be reversible');
assert.match(hostSource, /manager\.renderPromptManagerListItems = state\.originals\.renderPromptManagerListItems;/, 'teardown must restore the original renderer');

// --------------------------------------------------------- prompt entry storage
assert.match(stateSource, /if \(presetName && settings\?\.promptGroups\) settings\.promptGroups\[presetName\] = clone\(state\);/, 'prompt groups must be mirrored into extension settings on every change');
assert.match(stateSource, /root\[PORTABLE_NAMESPACE\]\[PORTABLE_FIELD\] = clone\(state\);/, 'prompt groups must also be written into the preset so they travel with an export');
assert.match(stateSource, /chosen = Number\(mirror\.updatedAt\) > Number\(portable\.updatedAt\) \? mirror : portable;/, 'the newer of the two copies must win');
assert.match(stateSource, /export function readCompatibleState\(\)/, '柏宝箱 metadata must be importable');
assert.match(stateSource, /root\[BAIBAI_NAMESPACE\]\?\.presetPromptGroups/, '柏宝箱 group metadata must be read from its own namespace');
assert.match(stateSource, /const legacy = root\.entryGrouping;/, 'the older entryGrouping shape must be read too');
assert.match(stateSource, /export function renamePreset\(oldName, newName\)/, 'renaming a preset must carry its groups across');
assert.match(stateSource, /export function forgetPreset\(presetName\)/, 'deleting a preset must drop its metadata');
assert.doesNotMatch(stateSource, /fetch\(['"`]\/api\/presets\/save/, 'this extension must never write preset files behind the user’s back');
assert.match(blocksSource, /if \(next\.length !== items\.length\) return false;/, 'reordering must refuse to run if it would change the entry count');
assert.match(blocksSource, /export function buildBlocks\(\{ items, idOf, assignments, groups \}\)/, 'preset entries and regex scripts must share one block model');

// -------------------------------------------------------------- list behaviours
assert.doesNotMatch(listSource, /<li class="sgp-block sgp-loose-block"[^>]*>\$\{renderRow/, 'a loose row must not be wrapped in another <li>, which the HTML parser would flatten');
assert.match(listSource, /blockId \? `data-sgp-block="\$\{escapeHtml\(blockId\)\}"` : ''/, 'a loose row must carry its own block id');
assert.match(listSource, /<div class="sgp-block pgm-group sgp-group/, 'group chrome must use a neutral div so mobile themes that restyle prompt li elements cannot corrupt it');
assert.doesNotMatch(listSource, /<li class="sgp-block pgm-group sgp-group/, 'group chrome must not masquerade as a native prompt row');
assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?\.sgp-group-head \{[\s\S]*?writing-mode:\s*horizontal-tb;/, 'mobile group headers must resist vertical-writing custom themes');
assert.match(listSource, /function syncBatchBar\(list\)/, 'batch controls must react to checkbox changes');
assert.match(listSource, /control\.disabled = !hasSelection;/, 'batch buttons must become usable as soon as something is selected');
assert.match(listSource, /syncBatchBar\(list\);/, 'the checkbox handler must refresh the batch bar');
assert.match(listSource, /const hasOpenMenu =[\s\S]*?if \(event\.key !== 'Escape' \|\| !hasOpenMenu\) return;[\s\S]*?event\.stopPropagation\(\);/, 'Escape must close only the active inline menu, not the host drawer behind it');
assert.match(listSource, /const shouldEnable = liveGroup\.enabled === false;\s*setGroupEnabled\(groupId, shouldEnable\);/, 'the mute toast must be decided before the live state is mutated');
assert.match(listSource, /const group = findGroup\(readState\(\), groupId\);\s*setGroupCollapsed\(groupId, group\?\.collapsed === false\);/, 'collapsing must read the previous value before writing');
// Rows keep the frequent edit/toggle controls visible; less common actions
// expand horizontally into the name cell without changing the row height.
assert.doesNotMatch(listSource, /data-sgp-favorite/, 'favourites were removed and must not come back');
assert.doesNotMatch(listSource, /sgp-star/, 'the star column must not reappear in the row');
assert.doesNotMatch(listSource, /data-sgp-mirror/, 'the favourites mirror rows must be gone');
assert.match(listSource, /prompt_manager_prompt_controls">\$\{menuActions\}\$\{menuButton\}\$\{editButton\}\$\{toggleButton\}/, 'row controls must follow the compact actions, ellipsis, edit, toggle order');
assert.match(listSource, /data-sgp-row-action="\$\{action\}"/, 'secondary row actions must use the inline ellipsis disclosure');
assert.match(listSource, /actionButton\('copy'/, 'copying must live inside the ellipsis disclosure');
assert.match(listSource, /actionButton\('detach'/, 'removing must live inside the ellipsis disclosure');
assert.match(listSource, /actionButton\('library'/, 'saving to the library must live inside the ellipsis disclosure');
assert.match(listSource, /data-sgp-menu-move/, 'moving to a group must live inside the ellipsis menu');
assert.match(listSource, /data-sgp-group-menu=/, 'group headers must expose one ellipsis menu instead of five loose actions');
assert.match(listSource, /data-sgp-group-action="power"[\s\S]*?data-sgp-group-action="up"[\s\S]*?data-sgp-group-action="down"[\s\S]*?data-sgp-group-action="rename"[\s\S]*?data-sgp-group-action="delete"/, 'the group ellipsis must contain power, move, rename and delete actions');
assert.match(styleSource, /li\.sgp-row \{\s*grid-template-columns:\s*minmax\(0, 1fr\) max-content max-content !important;\s*column-gap:\s*6px !important;/, 'prompt controls and tokens must use content-sized columns without the old fixed token gap');
assert.match(styleSource, /\.sgp-row-actions-open \.sgp-prompt-actions[\s\S]*?display:\s*inline-flex !important;/, 'row actions must expand inline rather than in a detached popover');
assert.match(styleSource, /min-width:\s*max-content !important;/, 'host span widths must not collapse the horizontal action strip');

assert.match(listSource, /export function isTakeoverEnabled\(\)/, 'the takeover must be switchable');
assert.match(listSource, /settings\?\.enabled && settings\?\.enhancePromptEntries/, 'the master switch must also disable the prompt entry takeover');
assert.match(listSource, /class="drag-handle ui-sortable-handle"/, 'the drag handle must keep the class SillyTavern uses to reveal it');
assert.match(listSource, /skipped \? `，\$\{skipped\} 个不支持开关已跳过` : ''/, 'batch toggling must report entries SillyTavern refuses to switch');
assert.match(listSource, /prefix\}prompt_manager_prompt/, 'rows must keep SillyTavern class names so host styling and other extensions still apply');
assert.match(listSource, /getScrollContainer\(\)/, 'rerendering must preserve the host scroll position');
assert.doesNotMatch(listSource, /innerHTML\s*=\s*[^`]*\$\{prompt\.name\}/, 'prompt names must never be interpolated unescaped');

// --------------------------------------------------------------- global library
assert.match(librarySource, /export function normalizeLibrary\(input\)/, 'library payloads must be sanitized before use');
assert.match(librarySource, /Array\.isArray\(input\) \? \{ items: input \}/, 'a bare array of snippets must still import');
assert.doesNotMatch(librarySource, /BaiBaoKu|baibaoku/, 'the library must not depend on the upstream custom backend');
assert.doesNotMatch(librarySource, /indexedDB/, 'the library lives in extension settings so it follows the user across browsers');
assert.match(librarySource, /settings\.promptLibrary = normalizeLibrary\(library\);/, 'every library mutation must persist a normalized copy');
assert.match(librarySource, /manager\.addPrompt\(\{ name: uniqueInsertName\(item\.name\), role: 'system', content: item\.content \}, identifier\)/, 'inserting must create a fresh prompt rather than a reference');
assert.match(librarySource, /order\.push\(\{ identifier, enabled: true \}\)/, 'an inserted snippet must be registered in the native prompt order');
assert.match(librarySource, /function uniqueIdentifier\(\)/, 'inserted prompts must never reuse an existing identifier');
assert.match(librarySource, /function uniqueInsertName\(name\)/, 'inserted prompts must not collide with an existing name');
assert.match(librarySource, /event\.key === 'Escape'[\s\S]*?event\.stopPropagation\(\);/, 'the snippet editor must swallow Escape instead of closing the host drawer');
assert.match(styleSource, /#sgp-library-dialog \.sgp-dialog-textarea \{[\s\S]*?resize:\s*vertical;/, 'the snippet body must be resizable');
assert.match(listSource, /function syncLibraryHost\(list\)[\s\S]*?list\.before\(host\);/, 'the global library must sit above and outside the prompt list');
assert.match(listSource, /data-sgp-library-drop/, 'snippets must be droppable into library folders');

// ----------------------------------------------------------------- regex groups
// SillyTavern's own sortable rebuilds the script array from the container's
// direct children. Once rows sit inside group wrappers those children carry no
// script id, so leaving it enabled would make it save an empty list.
assert.match(regexHostSource, /export function setNativeSortableEnabled\(enabled\)/, 'the native regex sortable must be switchable');
assert.match(regexHostSource, /list\.sortable\(enabled \? 'enable' : 'disable'\)/, 'the native sortable must actually be disabled, not just ignored');
assert.match(regexListSource, /setNativeSortableEnabled\(false\);/, 'taking over must disable the native sortable');
assert.match(regexListSource, /setNativeSortableEnabled\(true\);/, 'releasing must restore the native sortable');
assert.match(regexIndexSource, /setNativeSortableEnabled\(true\);/, 'teardown must restore the native sortable');

assert.doesNotMatch(regexHostSource, /^import \{[^}]*\} from '(?:\.\.\/){2,}/m, 'the regex engine must not be reached through a static import');
assert.match(regexHostSource, /await import\(\/\* webpackIgnore: true \*\/ candidate\)/, 'the regex engine must be loaded dynamically so a failure can degrade');
assert.match(regexHostSource, /typeof module\?\.getScriptsByType === 'function' && typeof module\?\.saveScriptsByType === 'function'/, 'the bridge must verify the engine API before trusting it');
assert.match(regexHostSource, /export function scopeKeyFor\(scriptType\)/, 'character and preset scripts need their own group scopes');
assert.match(regexHostSource, /return `scoped:\$\{avatar \|\| 'none'\}`;/, 'character groups must be keyed by avatar');

assert.match(regexListSource, /if \(scripts\.length && !rows\.size\) \{[\s\S]*?releaseList\(container\);/, 'group chrome must not be drawn before the host has rendered its rows');
assert.match(regexListSource, /body\.appendChild\(row\)/, 'native rows must be moved, never recreated, so their handlers survive');
assert.doesNotMatch(regexListSource, /\.regex-script-label[^\n]*innerHTML\s*=/, 'native regex rows must never be rewritten');
assert.match(regexListSource, /buttons\.appendChild\(select\)/, 'the move control must ride inside the row’s own ellipsis disclosure');
assert.match(regexListSource, /querySelector\('\.regex_script_buttons'\)/, 'the move control must target the host disclosure container');
assert.match(regexListSource, /node\.className = 'sgr-parked';/, 'rows filtered out by the search must be parked rather than detached');
assert.match(styleSource, /\.sgr-parked \{\s*display:\s*none;/, 'parked rows must not take up space');
assert.match(regexListSource, /row\.querySelector\('\.sgr-move'\)\?\.remove\(\);/, 'releasing must strip the controls this extension added');

assert.match(regexStateSource, /settings\.regexGroups\[key\] = normalizeScope\(settings\.regexGroups\[key\]\);/, 'regex group metadata lives in the extension settings');
assert.doesNotMatch(regexStateSource, /writePresetExtensionField|writeExtensionField/, 'this extension must not write regex groups into presets or character cards');
assert.match(regexStateSource, /export async function setGroupDisabled\(scriptType, groupId, disabled\)/, 'a whole regex group must be switchable at once');
assert.match(regexIndexSource, /catch \(error\) \{[\s\S]*?releaseAll\(\);/, 'a rendering failure must hand the list back to SillyTavern');
assert.match(regexIndexSource, /if \(!await connectRegexHost\(\)\) return false;/, 'regex grouping must stay inert without the host engine');
assert.match(regexIndexSource, /node\.closest\?\.\('\.sgr-shell'\)/, 'the observer must ignore our own mutations so reparenting cannot loop');
assert.match(indexSource, /if \(settings\.enhanceRegex\) void initRegex\(\);/, 'regex grouping must only connect when it is switched on');
assert.match(indexSource, /data-srg-setting="enhanceRegex"/, 'regex grouping must be exposed in the settings panel');

// ------------------------------------------------------------------- lifecycle
assert.match(promptsIndexSource, /bind\('OAI_PRESET_CHANGED_AFTER', \(\) => refreshFromHost\(\)\);/, 'switching presets must reload that preset’s groups');
assert.match(promptsIndexSource, /bind\('OAI_PRESET_IMPORT_READY', \(\) => refreshFromHost\(\{ collapseAll: true \}\)\);/, 'an imported preset must open collapsed');
assert.match(promptsIndexSource, /bind\('PRESET_RENAMED'/, 'a rename must migrate metadata');
assert.match(promptsIndexSource, /bind\('PRESET_DELETED'/, 'a delete must drop metadata');
assert.match(promptsIndexSource, /if \(!await connectHost\(\)\) return false;/, 'the extension must stay inert when host internals are unavailable');
assert.match(indexSource, /if \(settings\.enhancePromptEntries\) \{\s*void initPrompts\(\)/, 'the prompt takeover must only connect when it is switched on');
assert.match(promptsIndexSource, /function bindEntryEditAutoSave\(\)/, 'saving a preset after an entry edit must be opt-in wiring');
assert.match(promptsIndexSource, /if \(!settings\?\.promptAutoSaveOnEntryEdit \|\| !isTakeoverEnabled\(\)\) return;/, 'auto-saving must respect its setting');
assert.match(promptsIndexSource, /#completion_prompt_manager_popup_entry_form_save/, 'auto-saving must hook the native entry save button');
assert.match(hostSource, /export function requestPresetSave\(\)/, 'preset saving must go through the host button the user would click');
assert.doesNotMatch(indexSource, /promptFavoritesEnabled/, 'the favourites setting must be gone');
assert.match(indexSource, /data-srg-setting="promptAutoSaveOnEntryEdit"/, 'the auto-save setting must be exposed in the panel');
assert.match(indexSource, /data-srg-setting="collapsePresetInterface"/, 'preset interface collapsing must be exposed in the settings panel');
assert.match(presetCollapseSource, /#range_block_openai/, 'the preset sampling controls must be included in the collapsible section');
assert.match(presetCollapseSource, /#openai_settings/, 'the OpenAI preset setting blocks must be included in the collapsible section');
assert.match(presetCollapseSource, /!element\.querySelector\('#completion_prompt_manager, #advanced-ai-config-block, \.advanced-ai-config-block'\)/, 'the collapsible settings drawer must never swallow Prompt Manager or advanced tools');
assert.match(presetCollapseSource, /if \(wrapper instanceof HTMLElement\) return true;/, 'an existing settings drawer must keep a fixed ownership boundary');
assert.match(presetCollapseSource, /te-preset-wrapper/, 'an existing layout extension collapse must win instead of creating nested drawers');
assert.match(presetCollapseSource, /export function cleanupPresetInterfaceCollapse\(\)/, 'preset interface collapsing must be fully reversible');

console.log('ui-regressions.test.mjs: inherited and SGplus regressions verified');
