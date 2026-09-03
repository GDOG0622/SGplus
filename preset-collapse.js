import { settings } from './shared.js';

const WRAPPER_ID = 'sgp-preset-settings-collapse';
const CONTENT_CLASS = 'sgp-preset-settings-collapse-content';
const PLACEHOLDER_CLASS = 'sgp-preset-settings-placeholder';
const MOVED_ATTR = 'data-sgp-preset-settings-block';
const EXTERNAL_WRAPPER_ID = 'te-preset-wrapper';
const EXTERNAL_TOGGLE_SELECTOR = '#te_collapse_preset';

let observer = null;
let syncTimer = 0;
let placeholderSerial = 0;

function isEnabled() {
    return Boolean(settings?.enabled && settings?.collapsePresetInterface);
}

function externalCollapseIsActive() {
    if (document.getElementById(EXTERNAL_WRAPPER_ID)) return true;
    const toggle = document.querySelector(EXTERNAL_TOGGLE_SELECTOR);
    return toggle instanceof HTMLInputElement && toggle.checked;
}

function topLevelBlocks() {
    const settingsRoot = document.querySelector('#openai_settings');
    if (!(settingsRoot instanceof HTMLElement)) return [];

    const candidates = [
        document.querySelector('#range_block_openai'),
        settingsRoot.querySelector(':scope > div'),
        ...settingsRoot.querySelectorAll(':scope > div.range-block.m-t-1'),
    ].filter(element => (
        element instanceof HTMLElement
        && element.isConnected
        && !element.matches('#completion_prompt_manager, #advanced-ai-config-block, .advanced-ai-config-block')
        && !element.querySelector('#completion_prompt_manager, #advanced-ai-config-block, .advanced-ai-config-block')
        && !element.closest(`#${WRAPPER_ID}`)
        && !element.closest(`#${EXTERNAL_WRAPPER_ID}`)
    ));

    const result = [];
    for (const element of candidates) {
        if (result.includes(element) || result.some(parent => parent.contains(element))) continue;
        for (let index = result.length - 1; index >= 0; index--) {
            if (element.contains(result[index])) result.splice(index, 1);
        }
        result.push(element);
    }
    return result;
}

function makeWrapper(before) {
    if (!(before instanceof HTMLElement) || !before.parentElement) return null;
    const wrapper = document.createElement('div');
    wrapper.id = WRAPPER_ID;
    wrapper.className = 'inline-drawer wide100p flexFlowColumn';
    wrapper.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header userSettingsInnerExpandable">
            <b><span>预设设置</span></b>
            <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
        </div>
        <div class="inline-drawer-content ${CONTENT_CLASS}" style="display:none;"></div>
    `;
    before.before(wrapper);
    return wrapper;
}

function moveIntoWrapper(wrapper, blocks) {
    const content = wrapper?.querySelector(`.${CONTENT_CLASS}`);
    if (!(content instanceof HTMLElement)) return false;

    for (const block of blocks) {
        if (block.hasAttribute(MOVED_ATTR)) continue;
        const placeholder = document.createElement('span');
        const key = String(++placeholderSerial);
        placeholder.className = PLACEHOLDER_CLASS;
        placeholder.dataset.sgpPresetSettingsPlaceholder = key;
        placeholder.hidden = true;
        block.before(placeholder);
        block.setAttribute(MOVED_ATTR, key);
        content.append(block);
    }
    return true;
}

function wrap() {
    let wrapper = document.getElementById(WRAPPER_ID);
    // Once created, the drawer owns a fixed set of parameter blocks. Re-running
    // discovery after Prompt Manager mounts can otherwise capture its parent and
    // incorrectly hide the whole entry list inside "预设设置".
    if (wrapper instanceof HTMLElement) return true;
    const blocks = topLevelBlocks();
    if (!wrapper && blocks.length) wrapper = makeWrapper(blocks[0]);
    if (!(wrapper instanceof HTMLElement)) return false;
    return moveIntoWrapper(wrapper, blocks);
}

function unwrap() {
    const wrapper = document.getElementById(WRAPPER_ID);
    if (!(wrapper instanceof HTMLElement)) {
        document.querySelectorAll(`.${PLACEHOLDER_CLASS}`).forEach(node => node.remove());
        return;
    }

    const moved = [...wrapper.querySelectorAll(`[${MOVED_ATTR}]`)];
    for (const block of moved) {
        const key = block.getAttribute(MOVED_ATTR) || '';
        block.removeAttribute(MOVED_ATTR);
        const placeholder = document.querySelector(`.${PLACEHOLDER_CLASS}[data-sgp-preset-settings-placeholder="${CSS.escape(key)}"]`);
        if (placeholder) placeholder.replaceWith(block);
        else wrapper.before(block);
    }
    wrapper.remove();
    document.querySelectorAll(`.${PLACEHOLDER_CLASS}`).forEach(node => node.remove());
}

function queueSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
        syncTimer = 0;
        sync();
    }, 80);
}

function relevantMutation(mutation) {
    const selector = `#range_block_openai, #openai_settings, #${WRAPPER_ID}, #${EXTERNAL_WRAPPER_ID}, ${EXTERNAL_TOGGLE_SELECTOR}`;
    const relevant = node => node instanceof Element && (node.matches(selector) || node.querySelector(selector));
    return relevant(mutation.target) || [...mutation.addedNodes, ...mutation.removedNodes].some(relevant);
}

function bindObserver() {
    if (observer || typeof MutationObserver !== 'function') return;
    const root = document.querySelector('#left-nav-panel') || document.body;
    if (!root) return;
    observer = new MutationObserver(mutations => {
        if (mutations.some(relevantMutation)) queueSync();
    });
    observer.observe(root, { childList: true, subtree: true });
    document.addEventListener('change', handleExternalToggle, true);
}

function handleExternalToggle(event) {
    if (event.target?.matches?.(EXTERNAL_TOGGLE_SELECTOR)) queueSync();
}

function sync() {
    if (!isEnabled() || externalCollapseIsActive()) {
        unwrap();
        return false;
    }
    return wrap();
}

export function applyPresetInterfaceCollapse() {
    if (!isEnabled()) {
        cleanupPresetInterfaceCollapse();
        return false;
    }
    bindObserver();
    return sync();
}

export function cleanupPresetInterfaceCollapse() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = 0;
    observer?.disconnect();
    observer = null;
    document.removeEventListener('change', handleExternalToggle, true);
    unwrap();
}
