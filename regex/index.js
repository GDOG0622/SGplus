import { context, DISPLAY_NAME, settings } from '../shared.js';
import { connectRegexHost, isRegexHostConnected, LIST_TARGETS, setNativeSortableEnabled } from './host.js';
import { bindRowControls, isRegexTakeoverEnabled, logTakeover, releaseAll, renderAll, rerender, resetViews } from './list.js';

const cleanupFns = [];
let observer = null;
let syncTimer = 0;
let ready = false;

export function isRegexTakeoverReady() {
    return ready && isRegexHostConnected();
}

/**
 * SillyTavern rebuilds the three regex lists from scratch on many events, so
 * the grouping layer is reapplied whenever rows appear or disappear rather than
 * on a fixed schedule.
 */
function scheduleSync(delay = 90) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
        syncTimer = 0;
        try {
            renderAll();
            bindRowControls();
        } catch (error) {
            console.error(`[${DISPLAY_NAME}] 正则分组渲染失败，已恢复原生列表`, error);
            releaseAll();
            setNativeSortableEnabled(true);
        }
    }, delay);
}

function hostRebuiltList(mutation) {
    if (mutation.type !== 'childList') return false;
    for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
        if (!(node instanceof Element)) continue;
        // Ignore our own chrome so reparenting rows cannot loop.
        if (node.closest?.('.sgr-shell') && !node.matches?.('.regex-script-label')) continue;
        if (node.matches?.('.regex-script-label') || node.querySelector?.('.regex-script-label')) return true;
    }
    return false;
}

function observeLists() {
    observer?.disconnect();
    observer = new MutationObserver(mutations => {
        if (!isRegexTakeoverEnabled()) return;
        // A rebuild appends rows directly to the container, outside our shell.
        const relevant = mutations.some(mutation => (
            hostRebuiltList(mutation) && !(mutation.target instanceof Element && mutation.target.closest('.sgr-shell'))
        ));
        if (relevant) scheduleSync();
    });
    for (const target of LIST_TARGETS) {
        const container = document.querySelector(target.selector);
        if (container) observer.observe(container, { childList: true });
    }
}

function bindLifecycleEvents() {
    const eventSource = context?.eventSource || globalThis.eventSource;
    const eventTypes = context?.eventTypes || context?.event_types || globalThis.event_types || {};
    if (!eventSource?.on) return;

    const bind = (name, handler) => {
        const type = eventTypes[name];
        if (!type) return;
        eventSource.on(type, handler);
        cleanupFns.push(() => {
            try {
                eventSource.removeListener?.(type, handler);
                eventSource.off?.(type, handler);
            } catch {
                // Best-effort cleanup on page unload.
            }
        });
    };

    // Character and preset scripts live in their own scopes, so their groups
    // must be reloaded when either changes.
    const reload = () => {
        resetViews();
        scheduleSync(160);
    };
    bind('CHAT_CHANGED', reload);
    bind('CHARACTER_PAGE_LOADED', reload);
    bind('PRESET_CHANGED', reload);
    bind('OAI_PRESET_CHANGED_AFTER', reload);
    bind('SETTINGS_UPDATED', () => scheduleSync(200));
    bind('APP_READY', () => scheduleSync(200));
}

/**
 * Adds grouping on top of SillyTavern's own regex lists. The native rows are
 * reused as-is, so every built-in action, the bulk edit mode and any other
 * extension that queries `.regex-script-label` keep working.
 */
export async function initRegex() {
    if (ready) return true;
    if (!await connectRegexHost()) return false;

    observeLists();
    bindLifecycleEvents();

    const rootObserver = new MutationObserver(mutations => {
        const containerAppeared = mutations.some(mutation => [...mutation.addedNodes].some(node => (
            node instanceof Element && LIST_TARGETS.some(target => node.matches?.(target.selector) || node.querySelector?.(target.selector))
        )));
        if (containerAppeared) {
            observeLists();
            scheduleSync();
        }
    });
    rootObserver.observe(document.body, { childList: true, subtree: true });
    cleanupFns.push(() => rootObserver.disconnect());

    ready = true;
    scheduleSync(0);
    logTakeover();
    return true;
}

/** Re-applies or releases the grouping layer after the user flips its setting. */
export function refreshRegexTakeover() {
    if (!ready) {
        if (settings?.enhanceRegex) void initRegex();
        return;
    }
    if (!isRegexTakeoverEnabled()) {
        resetViews();
        releaseAll();
        setNativeSortableEnabled(true);
        return;
    }
    scheduleSync(0);
}

export function cleanupRegex() {
    if (syncTimer) clearTimeout(syncTimer);
    observer?.disconnect();
    observer = null;
    cleanupFns.splice(0).forEach(fn => {
        try {
            fn();
        } catch {
            // Nothing else to do during teardown.
        }
    });
    releaseAll();
    setNativeSortableEnabled(true);
    ready = false;
}

export { rerender as rerenderRegex };
