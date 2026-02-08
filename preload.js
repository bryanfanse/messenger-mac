const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
    SET_SIDEBAR_VISIBLE: 'messenger-app:set-sidebar-visible',
    CREATE_NEW_MESSAGE: 'messenger-app:create-new-message',
    SWITCH_CONVERSATION: 'messenger-app:switch-conversation',
    SHOW_RECONNECT_BANNER: 'messenger-app:show-reconnect-banner',
    CLEAR_RECONNECT_BANNER: 'messenger-app:clear-reconnect-banner',
    ATTACH_NETWORK_WATCHER: 'messenger-app:attach-network-watcher',
};

const RECONNECT_BANNER_ID = 'messenger-app-reconnect-banner';
let networkWatcherAttached = false;

function removeReconnectBanner() {
    const old = document.getElementById(RECONNECT_BANNER_ID);
    if (old) old.remove();
}

function renderReconnectBanner(message) {
    removeReconnectBanner();

    const banner = document.createElement('div');
    banner.id = RECONNECT_BANNER_ID;
    banner.style.cssText = [
        'position:fixed',
        'left:12px',
        'right:12px',
        'top:12px',
        'z-index:2147483647',
        'display:flex',
        'align-items:center',
        'justify-content:space-between',
        'gap:12px',
        'padding:10px 14px',
        'border-radius:12px',
        'background:rgba(7, 20, 42, 0.95)',
        'color:#f3f8ff',
        'font:500 13px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
        'box-shadow:0 8px 24px rgba(0, 0, 0, 0.25)',
    ].join(';');

    const text = document.createElement('div');
    text.textContent = message;

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex; gap:8px; flex-shrink:0;';

    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.style.cssText = [
        'border:none',
        'border-radius:999px',
        'padding:6px 12px',
        'background:#ffffff',
        'color:#0a2f75',
        'font:600 12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
        'cursor:pointer',
    ].join(';');
    retry.onclick = () => window.location.reload();

    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.style.cssText = [
        'border:1px solid rgba(255,255,255,0.5)',
        'border-radius:999px',
        'padding:6px 12px',
        'background:transparent',
        'color:#e6f0ff',
        'font:600 12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
        'cursor:pointer',
    ].join(';');
    dismiss.onclick = () => banner.remove();

    actions.appendChild(retry);
    actions.appendChild(dismiss);
    banner.appendChild(text);
    banner.appendChild(actions);
    document.body.appendChild(banner);
}

function syncNetworkBanner() {
    if (navigator.onLine) {
        removeReconnectBanner();
    } else {
        renderReconnectBanner('You are offline. Check your connection and retry.');
    }
}

function attachNetworkWatcher() {
    if (networkWatcherAttached) return;
    networkWatcherAttached = true;
    window.addEventListener('online', syncNetworkBanner);
    window.addEventListener('offline', syncNetworkBanner);
    syncNetworkBanner();
}

function setSidebarVisible(visible) {
    const sidebar = document.querySelector('[aria-label="Inbox switcher"]');
    if (sidebar) {
        sidebar.style.display = visible ? '' : 'none';
    }
}

function createNewMessage() {
    const newMessageBtn =
        document.querySelector('[aria-label="New message"]') ||
        document.querySelector('[aria-label="Start a new message"]') ||
        document.querySelector('[aria-label="Compose"]');
    if (newMessageBtn) {
        newMessageBtn.click();
    }
}

function switchConversation(index) {
    const rows = document.querySelectorAll('[role="row"]');
    const conversationLinks = [];

    rows.forEach((row) => {
        const link = row.querySelector('a[role="link"][href*="/t/"]');
        if (link) {
            conversationLinks.push(link);
        }
    });

    if (conversationLinks[index]) {
        conversationLinks[index].click();
    }
}

window.addEventListener('DOMContentLoaded', () => {
    ipcRenderer.on(CHANNELS.SET_SIDEBAR_VISIBLE, (_event, visible) => {
        setSidebarVisible(visible === true);
    });

    ipcRenderer.on(CHANNELS.CREATE_NEW_MESSAGE, () => {
        createNewMessage();
    });

    ipcRenderer.on(CHANNELS.SWITCH_CONVERSATION, (_event, index) => {
        if (Number.isInteger(index) && index >= 0) {
            switchConversation(index);
        }
    });

    ipcRenderer.on(CHANNELS.SHOW_RECONNECT_BANNER, (_event, message) => {
        renderReconnectBanner(typeof message === 'string' ? message : 'Connection issue.');
    });

    ipcRenderer.on(CHANNELS.CLEAR_RECONNECT_BANNER, () => {
        removeReconnectBanner();
    });

    ipcRenderer.on(CHANNELS.ATTACH_NETWORK_WATCHER, () => {
        attachNetworkWatcher();
    });
});

contextBridge.exposeInMainWorld('messengerMac', {
    version: '1.0.0',
});
