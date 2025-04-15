// public/extensions/third-party/chat-history-backup/index.js

// ==========================================================
// 1. Import SillyTavern Modules and Functions
// ==========================================================
// Note: Adjust paths if your ST version differs significantly

// From extensions.js
import {
    getContext,
    extension_settings,
    renderExtensionTemplateAsync // Optional, if using external HTML for UI
} from '../../../extensions.js';

// From script.js
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    chat,                   // Current chat messages array
    chat_metadata,          // Current chat metadata object
    getCurrentChatId,       // Gets the ID of the current chat file/identifier
    selectCharacterById,    // Function to switch to a character
    openGroupById,          // Function to switch to a group
    doNewChat,              // Function to create a new chat for the current character/group
    // createNewGroupChat is often called internally by doNewChat or group-chats.js logic when a group is active.
    // We might rely on doNewChat triggering the correct new chat creation based on context.
    clearChat,              // Clears chat UI and array
    printMessages,          // Renders messages from the chat array
    reloadCurrentChat,      // Force reloads the current chat
    saveChatConditional,    // Saves the current chat state if needed
    name1 as userName,      // User's name
    name2 as characterName, // Character's name (may be group name contextually)
    this_chid as currentCharacterId, // Currently selected character index
    selected_group as currentGroupId // Currently selected group ID
} from '../../../../script.js';

// From utils.js
import { debounce, escapeHtml } from '../../../utils.js';

// From constants.js
import { debounce_timeout } from '../../../constants.js';

// From popup.js
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';

// From i18n.js
import { t } from '../../../i18n.js';

// Ensure localforage is available (usually loaded globally by ST)
/** @type {import('localforage')} */
declare var localforage; // Use declare for type hints without actual import if needed

// ==========================================================
// 2. Plugin Constants and Settings
// ==========================================================
const extensionName = "chat-history-backup"; // MUST match the folder name
const defaultSettings = {
    isEnabled: true,
    // maxBackups: 3, // This is now a hardcoded constant below
};
// Global storage key for ALL backups
const STORAGE_KEY = "st_global_chat_backups_v1"; // Added versioning
const MAX_BACKUPS = 3; // Hardcoded max number of global backups
const BACKUP_DEBOUNCE_TIME = debounce_timeout.long; // e.g., 2000ms
const PREVIEW_LENGTH = 100; // Max characters for message preview

// ==========================================================
// 3. Load Plugin Settings
// ==========================================================
async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    Object.assign(extension_settings[extensionName], {
        ...defaultSettings,
        ...extension_settings[extensionName],
    });

    // Update UI elements based on loaded settings
    $('#chat-history-backup-enabled').prop('checked', extension_settings[extensionName].isEnabled);
}

// ==========================================================
// 4. Core Backup Function (`performBackup`)
// ==========================================================
async function performBackup() {
    const settings = extension_settings[extensionName];
    if (!settings.isEnabled) {
        console.log(`${extensionName}: Backup is disabled.`);
        updateStatusUI(t('备份已禁用'));
        return;
    }

    const context = getContext(); // Get current context
    let sourceType = null;
    let sourceId = null;
    let sourceName = null;
    let currentChatName = null; // The identifier of the specific chat file/session

    // Determine if we are in a character chat or group chat
    if (context.groupId) { // Check context first for group ID
        sourceType = 'group';
        sourceId = context.groupId;
        // Find group name - assuming groups array is accessible or use context if available
        // Simplified: using a placeholder if direct access isn't straightforward
        const group = context.groups?.find(g => g.id === sourceId);
        sourceName = group ? group.name : t('未知群组');
        currentChatName = group?.chat_id ?? t('未知聊天'); // Get current chat ID for the group
    } else if (context.characterId !== undefined && context.characterId !== null) { // Check context for character ID
        sourceType = 'character';
        sourceId = context.characterId;
        sourceName = context.name2; // Get character name from context
        // Find character to get the current chat file name
        const character = context.characters?.[sourceId];
        currentChatName = character?.chat ?? t('未知聊天');
    }

    if (!sourceType || sourceId === null || sourceId === undefined) {
        console.log(`${extensionName}: No active character or group found, skipping backup.`);
        updateStatusUI(t('无活动聊天'));
        return;
    }

    // Check if chat array exists and is not empty
    const currentChat = context.chat; // Access chat via context
    if (!currentChat || currentChat.length === 0) {
        console.log(`${extensionName}: Chat is empty, skipping backup for ${sourceType} ${sourceId}.`);
        updateStatusUI(t('聊天为空，跳过'));
        return;
    }

    // Deep copy chat and metadata
    let chatCopy;
    let metadataCopy;
    try {
        // Use structuredClone first (more efficient)
        chatCopy = structuredClone(currentChat);
        metadataCopy = structuredClone(context.chat_metadata); // Access metadata via context
    } catch (e) {
        console.warn(`${extensionName}: structuredClone failed, falling back to JSON method. Error: ${e}`);
        try {
            chatCopy = JSON.parse(JSON.stringify(currentChat));
            metadataCopy = JSON.parse(JSON.stringify(context.chat_metadata));
        } catch (jsonError) {
             console.error(`${extensionName}: Failed to deep copy chat data using JSON method. Aborting backup.`, jsonError);
             updateStatusUI(t('数据拷贝失败!'));
             toastr.error(t('无法备份聊天，数据拷贝失败。'), extensionName);
             return;
        }
    }


    // Get last message info
    const lastMessage = chatCopy[chatCopy.length - 1];
    const lastMessageId = chatCopy.length - 1;
    let lastMessagePreview = '';
    if (lastMessage && lastMessage.mes) {
         // Basic preview: strip HTML and truncate
         const tempDiv = document.createElement('div');
         tempDiv.innerHTML = lastMessage.mes; // Let browser parse HTML
         lastMessagePreview = (tempDiv.textContent || tempDiv.innerText || "").substring(0, PREVIEW_LENGTH);
    }


    // Build the backup object
    const newBackup = {
        timestamp: Date.now(),
        sourceType: sourceType,
        sourceId: sourceId,
        sourceName: sourceName,
        chatName: currentChatName,
        lastMessageId: lastMessageId,
        lastMessagePreview: escapeHtml(lastMessagePreview), // Escape preview for safe display
        chat: chatCopy,
        metadata: metadataCopy,
    };

    console.log(`${extensionName}: Preparing backup for ${sourceType} ${sourceName} (${sourceId}), chat: ${currentChatName}`);
    updateStatusUI(t('准备备份...'));

    try {
        // Get the current global backup list
        let backups = await localforage.getItem(STORAGE_KEY) || [];
        if (!Array.isArray(backups)) {
            console.warn(`${extensionName}: Invalid data found for ${STORAGE_KEY}, resetting backup list.`);
            backups = [];
        }

        // Add the new backup to the beginning
        backups.unshift(newBackup);

        // Truncate the list to MAX_BACKUPS
        if (backups.length > MAX_BACKUPS) {
            backups = backups.slice(0, MAX_BACKUPS);
        }

        // Save the updated list back to localForage
        await localforage.setItem(STORAGE_KEY, backups);
        console.log(`${extensionName}: Backup successful. Total global backups: ${backups.length}`);
        updateStatusUI(`${t('上次备份:')} ${new Date(newBackup.timestamp).toLocaleTimeString()}`);

        // Refresh the displayed list if the settings panel is visible
        displayBackups();

    } catch (error) {
        console.error(`${extensionName}: Error performing backup:`, error);
        toastr.error(`${t('备份聊天失败')}: ${error.message}`, `${extensionName}`);
        updateStatusUI(t('备份失败!'));

        // Handle QuotaExceededError specifically
        if (error && (error.name === 'QuotaExceededError' || error.message.includes('quota'))) {
            settings.isEnabled = false;
            $('#chat-history-backup-enabled').prop('checked', false);
            saveSettingsDebounced();
            callGenericPopup(t('浏览器存储空间已满，聊天备份插件已被禁用。请清理浏览器存储或手动删除旧备份。'), POPUP_TYPE.TEXT);
            updateStatusUI(t('存储已满，已禁用'));
        }
    }
}

// ==========================================================
// 5. Debounced Trigger
// ==========================================================
const debouncedBackup = debounce(performBackup, BACKUP_DEBOUNCE_TIME);

function triggerBackup() {
    if (extension_settings[extensionName]?.isEnabled) {
        console.debug(`${extensionName}: Backup triggered, debouncing...`);
        updateStatusUI(t('检测到活动，准备备份...'));
        debouncedBackup();
    }
}

// Helper to update status text
function updateStatusUI(message) {
    $('#chat-history-backup-status').text(message);
}

// ==========================================================
// 6. Display Backups in UI
// ==========================================================
async function displayBackups() {
    const container = $('#chat-history-backup-list');
    if (!container.length) return; // Don't proceed if container not found

    container.html(`<p><em>${t('正在加载备份列表...')}</em></p>`); // Loading indicator

    try {
        const backups = await localforage.getItem(STORAGE_KEY) || [];
        if (!Array.isArray(backups)) {
             console.warn(`${extensionName}: Invalid backup data found in storage.`);
             container.html(`<p>${t('无法加载备份，数据格式错误。')}</p>`);
             return;
        }

        if (backups.length === 0) {
            container.html(`<p>${t('没有可用的本地备份记录。')}</p>`);
            return;
        }

        let listHtml = '';
        backups.forEach((backup, index) => {
            const dateTime = new Date(backup.timestamp).toLocaleString();
            const sourceInfo = `${escapeHtml(backup.sourceName)} (${backup.sourceType === 'group' ? t('群组') : t('角色')})`;
            const chatInfo = `${escapeHtml(backup.chatName)}`;
            const messageCount = backup.chat?.length ?? 0;

            listHtml += `
                <div class="chat-history-backup-item">
                    <div class="backup-details">
                        <strong>${sourceInfo}</strong> - <em>${chatInfo}</em><br>
                        <small>${dateTime} (${messageCount} ${t('条消息')}, ID: ${backup.lastMessageId})</small><br>
                        <small class="backup-preview">${t('预览:')} ${backup.lastMessagePreview}...</small>
                    </div>
                    <div class="backup-actions">
                        <button class="menu_button restore-backup-button" data-backup-index="${index}" title="${t('恢复此备份到新聊天')}">
                            <i class="fa-solid fa-upload"></i> ${t('恢复')}
                        </button>
                    </div>
                </div>
            `;
        });

        container.html(listHtml);

    } catch (error) {
        console.error(`${extensionName}: Error displaying backups:`, error);
        container.html(`<p>${t('加载备份列表时出错。')}</p>`);
        toastr.error(t('加载备份列表失败。'), extensionName);
    }
}

// ==========================================================
// 7. Restore Functionality
// ==========================================================
async function restoreBackup(backupIndex) {
    if (isNaN(backupIndex) || backupIndex < 0) {
        toastr.error(t('无效的备份索引。'), extensionName);
        return;
    }

    let backups = [];
    try {
        backups = await localforage.getItem(STORAGE_KEY) || [];
    } catch (error) {
        console.error(`${extensionName}: Failed to retrieve backups for restore:`, error);
        toastr.error(t('获取备份数据失败。'), extensionName);
        return;
    }

    if (backupIndex >= backups.length) {
        toastr.error(t('备份索引超出范围，请刷新列表。'), extensionName);
        displayBackups(); // Refresh the list as it might be outdated
        return;
    }

    const backupData = backups[backupIndex];

    if (!backupData || !backupData.chat || !backupData.metadata || !backupData.sourceType || backupData.sourceId === undefined) {
        toastr.error(t('备份数据无效或不完整，无法恢复。'), extensionName);
        return;
    }

    const confirmMessage = `
        <h4>${t('确认恢复备份')}</h4>
        <p>${t('将为 <strong>{sourceName}</strong> ({sourceType}) 创建一个新的聊天会话，并将 {dateTime} 的备份内容恢复到其中。').replace('{sourceName}', escapeHtml(backupData.sourceName)).replace('{sourceType}', backupData.sourceType === 'group' ? t('群组') : t('角色')).replace('{dateTime}', new Date(backupData.timestamp).toLocaleString())}</p>
        <p><strong>${t('当前打开的聊天不会被覆盖，但您需要切换到新创建的聊天。')}</strong></p>
        <p><small>${t('此操作会保存角色/群组信息以指向新聊天。')}</small></p>
    `;

    try {
        // Confirm with the user
        const userConfirmed = await callGenericPopup(confirmMessage, POPUP_TYPE.CONFIRM);
        if (!userConfirmed) {
            console.log(`${extensionName}: Restore cancelled by user.`);
            return;
        }

        toastr.info(t('正在准备恢复环境...'), extensionName);
        console.log(`${extensionName}: Starting restore for backup from ${new Date(backupData.timestamp).toLocaleString()}`);

        // 1. Switch context to the source character/group
        console.log(`${extensionName}: Switching context to ${backupData.sourceType} ${backupData.sourceId}`);
        if (backupData.sourceType === 'character') {
            await selectCharacterById(backupData.sourceId);
        } else if (backupData.sourceType === 'group') {
            await openGroupById(backupData.sourceId);
        } else {
            throw new Error(`Unknown sourceType: ${backupData.sourceType}`);
        }
        // Short delay to allow context switching to potentially complete UI updates
        await new Promise(resolve => setTimeout(resolve, 200));
        console.log(`${extensionName}: Context switched.`);

        // 2. Create a new chat for the current character/group
        console.log(`${extensionName}: Creating new chat...`);
        // doNewChat handles both character and group cases based on current context
        await doNewChat();
        // Short delay to allow new chat creation and initial loading
        await new Promise(resolve => setTimeout(resolve, 300));
        console.log(`${extensionName}: New chat created.`);

        // 3. Inject the backed-up data into the *current* global chat variables
        //    (which should now belong to the newly created chat)
        console.log(`${extensionName}: Injecting backup data...`);
        // Clear existing chat array and replace with backup chat content
        chat.splice(0, chat.length, ...backupData.chat);
        // Clear existing metadata and assign backup metadata
        // Need to get a reference to the actual global chat_metadata, context might be stale after async ops
        const globalMetadata = getContext().chat_metadata; // Re-fetch context's metadata ref
        Object.keys(globalMetadata).forEach(key => delete globalMetadata[key]);
        Object.assign(globalMetadata, backupData.metadata);

        // 4. Re-render the chat messages
        console.log(`${extensionName}: Rendering messages...`);
        await printMessages(true); // true for full refresh, handles showMoreMessages logic internally
        console.log(`${extensionName}: Messages rendered.`);

        // 5. Save the newly created and populated chat state
        console.log(`${extensionName}: Saving restored chat state...`);
        await saveChatConditional(); // Saves the current state (which is the restored state)
        console.log(`${extensionName}: Restored chat state saved.`);

        toastr.success(t('备份已成功恢复到新的聊天会话中！'), extensionName);

    } catch (error) {
        console.error(`${extensionName}: Error during restore process:`, error);
        toastr.error(`${t('恢复过程中发生错误')}: ${error.message}`, extensionName);
        // Optionally try to reload the original state before restore attempt
        // await reloadCurrentChat();
    }
}


// ==========================================================
// 8. Plugin Initialization (jQuery Ready)
// ==========================================================
jQuery(async () => {
    // --- 1. Create Plugin Settings UI HTML ---
    const settingsHtml = `
        <div id="chat-history-backup-settings" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${t('聊天历史备份 (全局)')}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label for="chat-history-backup-enabled">
                    <input type="checkbox" id="chat-history-backup-enabled">
                    ${t('启用自动备份 (最近 {count} 条记录)').replace('{count}', MAX_BACKUPS)}
                </label>
                <div id="chat-history-backup-status" class="backup-status-text">${t('正在初始化...')}</div>

                <hr>
                <h4>${t('已保存的备份记录')}</h4>
                 <button id="chat-history-backup-refresh" class="menu_button small_button" title="${t('刷新列表')}">
                     <i class="fa-solid fa-arrows-rotate"></i> ${t('刷新')}
                 </button>
                 <div id="chat-history-backup-list" class="backup-list-container">
                     ${/* Content will be loaded by displayBackups() */}
                 </div>
                 <hr class="sysHR">
                 <small>${t('备份存储在浏览器本地 (IndexedDB)。清理浏览器数据可能会删除备份。全局最多保留 {count} 条最新备份。').replace('{count}', MAX_BACKUPS)}</small>
            </div>
        </div>
    `;

    // --- 2. Inject HTML into Settings Page ---
    // Common targets: #extensions_settings, #settings_extensions, #extension_settings_lower_zone
    // Check your ST version's DOM structure. Using a common one here.
    $('#extensions_settings').append(settingsHtml);

    // --- 3. Load Settings ---
    await loadSettings();
    updateStatusUI(extension_settings[extensionName].isEnabled ? t('等待聊天活动...') : t('备份已禁用'));

    // --- 4. Bind UI Event Listeners ---
    // Enable/Disable Checkbox
    $('#chat-history-backup-enabled').on('change', function () {
        extension_settings[extensionName].isEnabled = $(this).prop('checked');
        saveSettingsDebounced();
        updateStatusUI(extension_settings[extensionName].isEnabled ? t('等待聊天活动...') : t('备份已禁用'));
        if (extension_settings[extensionName].isEnabled) {
            triggerBackup(); // Trigger a backup check when enabled
        } else {
             // Cancel any pending debounced backup if disabled
             if (typeof debouncedBackup.cancel === 'function') {
                 debouncedBackup.cancel();
                 updateStatusUI(t('备份已禁用'));
             }
        }
    });

    // Refresh Button
    $('#chat-history-backup-refresh').on('click', displayBackups);

    // Restore Button (Event Delegation)
    // Listen on a static parent element (#extensions_settings or body)
    $('#extensions_settings').on('click', '.restore-backup-button', function () {
        const backupIndex = parseInt($(this).data('backup-index'), 10);
        restoreBackup(backupIndex);
    });

    // --- 5. Load Initial Backup List ---
    displayBackups();

    // --- 6. Register SillyTavern Event Listeners for Auto-Backup ---
    const eventsToTriggerBackup = [
        event_types.MESSAGE_SENT,
        event_types.GENERATION_ENDED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_DELETED,
        // Add other relevant events if needed, e.g., world info updates might change context
        // event_types.WORLDINFO_UPDATED
    ];
    eventsToTriggerBackup.forEach(eventType => {
        eventSource.on(eventType, triggerBackup);
    });

    // Optionally cancel pending backup on chat change
     eventSource.on(event_types.CHAT_CHANGED, () => {
         if (typeof debouncedBackup.cancel === 'function') {
             debouncedBackup.cancel();
             console.debug(`${extensionName}: Chat changed, cancelled pending backup.`);
         }
         // Update status based on current setting after chat change
         updateStatusUI(extension_settings[extensionName]?.isEnabled ? t('等待聊天活动...') : t('备份已禁用'));
     });


    // --- 7. Plugin Load Completion Log ---
    console.log(`Plugin ${extensionName} loaded.`);
}); // jQuery Ready End
