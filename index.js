import { getContext, extension_settings, loadExtensionSettings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, chat, chat_metadata, getCurrentChatId, clearChat, printMessages, saveChatConditional } from '../../../../script.js';
import { debounce } from '../../../utils.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';
import { t } from '../../../i18n.js';

const extensionName = "chat-history-backup";
const defaultSettings = {
    isEnabled: true,
    maxBackups: 3,
    backupInterval: 2000
};

// Web Worker setup
const backupWorker = new Worker('extensions/third-party/chat-history-backup/backup-worker.js');

async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    Object.assign(extension_settings[extensionName], {
        ...defaultSettings,
        ...extension_settings[extensionName]
    });
}

// Backup trigger with debounce
const debouncedBackup = debounce(() => {
    if (!extension_settings[extensionName]?.isEnabled) return;
    
    const context = getContext();
    const chatId = context.getCurrentChatId();
    if (!chatId) return;

    backupWorker.postMessage({
        type: 'backup',
        data: {
            chat: structuredClone(chat),
            metadata: structuredClone(chat_metadata),
            chatId,
            maxBackups: extension_settings[extensionName].maxBackups
        }
    });
}, extension_settings[extensionName]?.backupInterval || 2000);

// Restore functionality
async function restoreBackup(backup) {
    const context = getContext();
    
    // Create new chat
    const newChatId = `${context.characterId}_restored_${Date.now()}`;
    await clearChat();
    
    // Restore messages
    for (const message of backup.chat) {
        context.addOneMessage(message);
    }
    
    // Restore metadata
    Object.assign(chat_metadata, backup.metadata);
    
    // Save and refresh
    await saveChatConditional();
    await printMessages();
}

// UI Setup
jQuery(async () => {
    // Load settings
    await loadSettings();

    // Inject UI
    const settingsHtml = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${t('Chat History Backup')}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label>
                <input type="checkbox" id="chat-backup-enabled" ${extension_settings[extensionName].isEnabled ? 'checked' : ''}>
                ${t('Enable Auto Backup')}
            </label>
            <div id="backup-list"></div>
            <button id="refresh-backups" class="menu_button">${t('Refresh Backups')}</button>
        </div>
    </div>`;
    $('#extensions_settings').append(settingsHtml);

    // Event listeners
    $('#chat-backup-enabled').on('change', function() {
        extension_settings[extensionName].isEnabled = $(this).is(':checked');
        saveSettingsDebounced();
    });

    $('#refresh-backups').on('click', async () => {
        backupWorker.postMessage({ type: 'list' });
    });

    // Web Worker message handling
    backupWorker.onmessage = function(event) {
        const { type, data } = event.data;
        
        if (type === 'backupComplete') {
            toastr.success(t('Backup completed successfully'));
        } else if (type === 'backupList') {
            const backupList = $('#backup-list').empty();
            data.forEach(backup => {
                backupList.append(`
                <div class="backup-item">
                    <p>${new Date(backup.timestamp).toLocaleString()}</p>
                    <p>${backup.chat[backup.chat.length - 1].mes.substring(0, 100)}...</p>
                    <button class="restore-btn" data-backup='${JSON.stringify(backup)}'>${t('Restore')}</button>
                </div>`);
            });
            
            $('.restore-btn').on('click', function() {
                const backup = JSON.parse($(this).data('backup'));
                restoreBackup(backup);
            });
        }
    };

    // Event listeners for auto backup
    eventSource.on(event_types.MESSAGE_SENT, debouncedBackup);
    eventSource.on(event_types.MESSAGE_RECEIVED, debouncedBackup);
});
