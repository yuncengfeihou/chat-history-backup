// public/extensions/third-party/global-chat-backup/index.js

// ==========================================================
// 1. Imports
// ==========================================================
import {
    getContext,
    extension_settings,
    renderExtensionTemplateAsync, // Keep in case we use a template later
} from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    chat,
    chat_metadata,
    getCurrentChatId,
    clearChat,
    printMessages,
    reloadCurrentChat, // Good fallback on error
    saveChatConditional,
    selectCharacterById,
    doNewChat,
    name1, // User name (less relevant here)
    name2, // Character name
    this_chid, // Current character ID
    characters, // All characters data
    groups, // All groups data
    selected_group, // Current group ID
    openGroupById,
    createNewGroupChat,
    t, // i18n translation function
} from '../../../../script.js';
import { debounce } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';
import { POPUP_TYPE, callGenericPopup, POPUP_RESULT } from '../../../popup.js';

// Make TypeScript/JSDoc aware of localforage if not explicitly imported
declare var localforage: any;

// ==========================================================
// 2. Constants and Settings
// ==========================================================
const extensionName = "global-chat-backup";
const defaultSettings = {
    isEnabled: true,
    maxBackups: 3, // Global maximum backups
};
// Single storage key for the global list of backups
const STORAGE_KEY = "st_global_chat_backups_list";
const BACKUP_DEBOUNCE_TIME = debounce_timeout.long; // e.g., 2000ms

// ==========================================================
// 3. Load Settings
// ==========================================================
async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    Object.assign(extension_settings[extensionName], {
        ...defaultSettings,
        ...extension_settings[extensionName],
    });

    // Update UI elements based on loaded settings
    $('#global-backup-enabled').prop('checked', extension_settings[extensionName].isEnabled);
    $('#global-backup-max').val(extension_settings[extensionName].maxBackups);
}

// ==========================================================
// 4. Core Backup Function (`performBackup`)
// ==========================================================
async function performBackup() {
    const settings = extension_settings[extensionName];
    if (!settings.isEnabled) {
        console.log(`${extensionName}: Backup is disabled.`);
        updateStatus(t('备份已禁用'));
        return;
    }

    const context = getContext();
    const currentChatId = context.getCurrentChatId(); // Gets char file or group chat ID

    // Determine source type and ID
    let sourceType: 'character' | 'group';
    let sourceId: number | string | undefined;
    let sourceName: string = t('未知来源');
    let chatName: string = t('未知聊天');

    if (context.selected_group !== null && context.selected_group !== undefined) {
        sourceType = 'group';
        sourceId = context.selected_group;
        const group = context.groups.find(g => g.id === sourceId);
        if (group) {
            sourceName = group.name;
            chatName = group.chat_id; // The current chat ID for the group
        }
    } else if (context.characterId !== undefined) {
        sourceType = 'character';
        sourceId = context.characterId;
        const character = context.characters[sourceId];
        if (character) {
            sourceName = character.name;
            chatName = character.chat; // The current chat file name for the character
        }
    } else {
        console.log(`${extensionName}: No active character or group selected, skipping backup.`);
        updateStatus(t('无活动聊天'));
        return; // No active chat source
    }

    // Use global chat and metadata from context
    const currentChat = context.chat;
    const currentMetadata = context.chat_metadata;

    if (!currentChat || currentChat.length === 0) {
        console.log(`${extensionName}: Chat is empty for ${sourceName}, skipping backup.`);
        updateStatus(t('聊天为空，跳过'));
        return;
    }

    updateStatus(t('准备备份...'));
    console.log(`${extensionName}: Preparing backup for ${sourceType} ${sourceName} (ID: ${sourceId}) - Chat: ${chatName}`);

    // Deep copy chat and metadata
    let chatCopy, metadataCopy;
    try {
        chatCopy = structuredClone(currentChat);
        metadataCopy = structuredClone(currentMetadata);
    } catch (e) {
        console.warn(`${extensionName}: structuredClone failed, falling back to JSON method. Error: ${e}`);
        try {
            chatCopy = JSON.parse(JSON.stringify(currentChat));
            metadataCopy = JSON.parse(JSON.stringify(currentMetadata));
        } catch (jsonError) {
            console.error(`${extensionName}: Failed to deep copy chat data using JSON method. Aborting backup.`, jsonError);
            toastr.error(t('无法复制聊天数据进行备份。'));
            updateStatus(t('备份失败 (复制错误)'));
            return;
        }
    }

    // Get last message info
    const lastMessageIndex = chatCopy.length - 1;
    const lastMessage = chatCopy[lastMessageIndex];
    const lastMessagePreview = lastMessage?.mes?.substring(0, 100) || t('[无消息内容]');

    // Create the backup entry object
    const backupEntry = {
        timestamp: Date.now(),
        sourceType: sourceType,
        sourceId: sourceId,
        sourceName: sourceName,
        chatName: chatName,
        lastMessageId: lastMessageIndex, // Store the index
        lastMessagePreview: lastMessagePreview,
        chat: chatCopy,
        metadata: metadataCopy,
    };

    try {
        // Get the current global backup list
        let backups = await localforage.getItem(STORAGE_KEY) || [];
        if (!Array.isArray(backups)) {
            console.warn(`${extensionName}: Invalid data found for key ${STORAGE_KEY}, resetting backup list.`);
            backups = [];
        }

        // Add the new backup to the beginning
        backups.unshift(backupEntry);

        // Trim the list to the maximum allowed size
        if (backups.length > settings.maxBackups) {
            backups = backups.slice(0, settings.maxBackups);
        }

        // Save the updated global list back to localForage
        await localforage.setItem(STORAGE_KEY, backups);

        console.log(`${extensionName}: Backup successful. Total global backups: ${backups.length}`);
        updateStatus(`${t('上次备份:')} ${new Date(backupEntry.timestamp).toLocaleTimeString()}`);
        // Refresh the displayed list after successful backup
        await displayBackups();

    } catch (error: any) {
        console.error(`${extensionName}: Error performing backup:`, error);
        updateStatus(t('备份失败!'));

        if (error && error.name === 'QuotaExceededError') {
            toastr.error(t('浏览器存储空间已满，无法保存备份。插件已自动禁用。'), t('备份失败'));
            // Disable the plugin automatically
            extension_settings[extensionName].isEnabled = false;
            $('#global-backup-enabled').prop('checked', false);
            saveSettingsDebounced();
            updateStatus(t('备份已禁用 (存储空间已满)'));
            // Also refresh display to show the disabled state properly
            await displayBackups(); // Refresh list to show it might be empty/stale
        } else {
            toastr.error(`${t('备份聊天失败')}: ${error.message}`, `${extensionName}`);
        }
    }
}

// ==========================================================
// 5. Debounce and Trigger
// ==========================================================
const debouncedBackup = debounce(performBackup, BACKUP_DEBOUNCE_TIME);

function triggerBackup() {
    if (extension_settings[extensionName]?.isEnabled) {
        // console.debug(`${extensionName}: Backup triggered, debouncing...`); // Optional: Can be spammy
        debouncedBackup();
    }
}

// ==========================================================
// 6. Display Backups in UI
// ==========================================================
async function displayBackups() {
    const listContainer = $('#global-backup-list-container');
    listContainer.empty().append(`<p><em>${t('正在加载备份...')}</em></p>`); // Loading indicator

    try {
        const backups = await localforage.getItem(STORAGE_KEY) || [];
        listContainer.empty(); // Clear loading indicator

        if (!Array.isArray(backups) || backups.length === 0) {
            listContainer.append(`<p>${t('没有可用的全局备份。')}</p>`);
            return;
        }

        backups.forEach((backup, index) => {
            const dateStr = new Date(backup.timestamp).toLocaleString();
            const sourceTypeText = backup.sourceType === 'character' ? t('角色') : t('群组');
            const mesCount = backup.chat?.length ?? 0;

            // Sanitize preview text just in case
            const previewText = $('<div>').text(backup.lastMessagePreview).html(); // Basic sanitization

            const entryHtml = `
                <div class="global-backup-entry">
                    <div class="global-backup-entry-info">
                        <div class="backup-details">
                            <strong>${sourceTypeText}:</strong> ${backup.sourceName || t('未知名称')} <br/>
                            <strong>${t('聊天')}:</strong> ${backup.chatName || t('未知聊天')} (${mesCount} ${t('条')})<br/>
                            <strong>${t('时间')}:</strong> ${dateStr}
                        </div>
                        <div class="backup-preview">${previewText}...</div>
                    </div>
                    <button class="menu_button restore-backup" data-backup-index="${index}" title="${t('恢复此备份到一个新聊天')}">
                        <i class="fa-solid fa-upload"></i> ${t('恢复')}
                    </button>
                </div>
            `;
            listContainer.append(entryHtml);
        });

    } catch (error) {
        console.error(`${extensionName}: Error loading backups for display:`, error);
        listContainer.empty().append(`<p style="color: red;">${t('加载备份列表失败。')}</p>`);
    }
}

// ==========================================================
// 7. Restore Function
// ==========================================================
async function restoreBackup(index: number) {
    updateStatus(t('准备恢复...'));
    try {
        const backups = await localforage.getItem(STORAGE_KEY) || [];
        if (!Array.isArray(backups) || index < 0 || index >= backups.length) {
            toastr.error(t('无法找到选定的备份。'));
            updateStatus(t('恢复失败 (无效索引)'));
            return;
        }

        const backupData = backups[index];

        if (!backupData || !backupData.chat || !backupData.metadata || !backupData.sourceId || !backupData.sourceType) {
            toastr.error(t('备份数据无效或不完整，无法恢复。'));
            updateStatus(t('恢复失败 (数据无效)'));
            console.error(`${extensionName}: Invalid backup data at index ${index}`, backupData);
            return;
        }

        // Confirmation Popup
        const confirm = await callGenericPopup(
            `<h4>${t('确认恢复?')}</h4>
             <p>${t('这将首先切换到 {sourceType} "{sourceName}"，然后为其创建一个全新的聊天会话，并将备份内容恢复到该新会话中。', { sourceType: backupData.sourceType === 'character' ? t('角色') : t('群组'), sourceName: backupData.sourceName })}</p>
             <p><strong>${t('备份时间:')}</strong> ${new Date(backupData.timestamp).toLocaleString()}</p>
             <p style="color: var(--SmartThemeWarnColor);">${t('当前聊天（如果存在）不会被覆盖，但您需要手动切换回。')}</p>`,
            POPUP_TYPE.CONFIRM,
            undefined, // No default value for confirm
            { okButton: t('确认恢复'), cancelButton: t('取消') }
        );

        if (!confirm) {
            updateStatus(t('恢复已取消'));
            return;
        }

        updateStatus(t('正在恢复: 切换上下文...'));
        console.log(`${extensionName}: Starting restore for backup index ${index}`);

        // --- Step 1: Switch context ---
        try {
            if (backupData.sourceType === 'character') {
                await selectCharacterById(backupData.sourceId);
            } else { // sourceType === 'group'
                await openGroupById(backupData.sourceId);
            }
            // Brief pause to allow context switch to settle (might not be strictly needed)
            await new Promise(resolve => setTimeout(resolve, 200));
            console.log(`${extensionName}: Context switched to ${backupData.sourceType} ${backupData.sourceId}`);
        } catch (switchError) {
             console.error(`${extensionName}: Error switching context during restore:`, switchError);
             toastr.error(t('切换到目标角色/群组时出错。无法继续恢复。'));
             updateStatus(t('恢复失败 (切换错误)'));
             return;
        }

        // --- Step 2: Create a new chat for the context ---
        updateStatus(t('正在恢复: 创建新聊天...'));
        let newChatName = '';
        try {
            if (backupData.sourceType === 'character') {
                // doNewChat handles saving the character with the new chat file name
                await doNewChat();
                newChatName = characters[backupData.sourceId as number]?.chat; // Get the newly created chat name
            } else { // sourceType === 'group'
                // createNewGroupChat handles saving the group with the new chat id
                await createNewGroupChat(backupData.sourceId);
                newChatName = groups.find(g => g.id === backupData.sourceId)?.chat_id; // Get the newly created chat id
            }
            // Wait for the new chat creation and initial load (getChat/getGroupChat) to finish
            await new Promise(resolve => setTimeout(resolve, 300)); // Increased delay slightly
            console.log(`${extensionName}: New chat created: ${newChatName}`);
        } catch (newChatError) {
            console.error(`${extensionName}: Error creating new chat during restore:`, newChatError);
            toastr.error(t('创建新聊天时出错。无法继续恢复。'));
            updateStatus(t('恢复失败 (创建错误)'));
            return;
        }


        // --- Step 3: Inject backed up data ---
        updateStatus(t('正在恢复: 注入数据...'));
        try {
            // Clear potentially existing initial message(s) in the new chat
            chat.length = 0;
            // Inject messages (make sure backupData.chat is the array)
            chat.splice(0, 0, ...backupData.chat);

            // Inject metadata
            Object.keys(chat_metadata).forEach(key => delete chat_metadata[key]); // Clear existing keys
            Object.assign(chat_metadata, backupData.metadata); // Assign restored metadata

            console.log(`${extensionName}: Data injected. ${chat.length} messages.`);
        } catch (injectError) {
            console.error(`${extensionName}: Error injecting data during restore:`, injectError);
            toastr.error(t('将备份数据注入新聊天时出错。'));
            updateStatus(t('恢复失败 (注入错误)'));
            return;
        }


        // --- Step 4: Re-render the chat UI ---
        updateStatus(t('正在恢复: 渲染消息...'));
        try {
            await printMessages(true); // Force full refresh, handles 'show more' logic
            console.log(`${extensionName}: Chat rendered.`);
        } catch (renderError) {
            console.error(`${extensionName}: Error rendering messages during restore:`, renderError);
            toastr.error(t('渲染恢复的消息时出错。'));
            // Continue to saving step, UI might be broken but data might be saved
        }


        // --- Step 5: Save the newly restored state ---
        updateStatus(t('正在恢复: 保存状态...'));
        try {
            await saveChatConditional(); // Save the new chat with restored content
            console.log(`${extensionName}: Restored chat saved.`);
        } catch (saveError) {
            console.error(`${extensionName}: Error saving restored chat:`, saveError);
            toastr.error(t('保存恢复后的聊天状态时出错。'));
            // Restore technically finished, but saving failed
        }

        toastr.success(t('聊天已从备份恢复到新的会话中！'));
        updateStatus(t('恢复成功'));


    } catch (error) {
        console.error(`${extensionName}: Unexpected error during restore process:`, error);
        toastr.error(t('恢复过程中发生意外错误。'));
        updateStatus(t('恢复失败 (未知错误)'));
        // Attempt to reload the original chat as a fallback? Maybe too risky.
        // await reloadCurrentChat();
    }
}

// ==========================================================
// 8. UI Update Helper
// ==========================================================
function updateStatus(message: string) {
    $('#global-backup-status').text(message);
}

// ==========================================================
// 9. Plugin Initialization
// ==========================================================
jQuery(async () => {
    // --- 1. Create settings UI ---
    const settingsHtml = `
        <div id="global-backup-settings" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${t('全局聊天备份')}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label for="global-backup-enabled">
                    <input type="checkbox" id="global-backup-enabled">
                    ${t('启用自动备份')}
                </label>
                <label for="global-backup-max" style="margin-top: 5px;">
                    ${t('最多保留全局备份数:')}
                    <input type="number" id="global-backup-max" min="1" max="10" class="text_pole" style="width: 50px;">
                </label>
                <div id="global-backup-status" style="font-size: 0.9em; color: var(--SmartThemeSubtleColor); margin-top: 5px;">${t('正在初始化...')}</div>
                <button id="global-backup-refresh" class="menu_button" style="margin-top: 10px;">
                    <i class="fa-solid fa-arrows-rotate"></i> ${t('刷新备份列表')}
                </button>
                <div id="global-backup-list-container">
                    ${t('正在加载备份...')}
                </div>
                 <hr class="sysHR">
                <small>${t('备份存储在浏览器本地。清理浏览器缓存或站点数据会删除所有备份。仅保留全局最新的 N 条备份。')}</small>
            </div>
        </div>
    `;

    // --- 2. Inject UI ---
    $('#extensions_settings').append(settingsHtml);

    // --- 3. Load settings and initial display ---
    await loadSettings();
    updateStatus(extension_settings[extensionName].isEnabled ? t('等待聊天活动...') : t('备份已禁用'));
    await displayBackups(); // Load and display backups on startup

    // --- 4. Bind UI event listeners ---
    $('#global-backup-enabled').on('change', async function () {
        extension_settings[extensionName].isEnabled = $(this).prop('checked');
        saveSettingsDebounced();
        updateStatus(extension_settings[extensionName].isEnabled ? t('等待聊天活动...') : t('备份已禁用'));
        if (extension_settings[extensionName].isEnabled) {
            triggerBackup(); // Trigger a backup check if just enabled
        }
        await displayBackups(); // Refresh display in case status matters
    });

    $('#global-backup-max').on('input', function() { // Use 'input' for immediate feedback
        let value = parseInt($(this).val() as string, 10);
        if (isNaN(value) || value < 1) value = 1;
        if (value > 10) value = 10; // Hard limit for sanity
        // No need to update val immediately if using 'input'
        extension_settings[extensionName].maxBackups = value;
        saveSettingsDebounced();
        // Optionally, trigger a backup or cleanup immediately if number decreases?
        // Maybe too complex, let natural backup cycle handle trimming.
    }).on('change', function() { // Ensure value is correct on blur/enter
        $(this).val(extension_settings[extensionName].maxBackups);
    });


    $('#global-backup-refresh').on('click', displayBackups);

    // Event delegation for restore buttons
    $('#global-backup-list-container').on('click', '.restore-backup', function () {
        const index = parseInt($(this).data('backup-index'), 10);
        if (!isNaN(index)) {
            restoreBackup(index);
        } else {
            console.error(`${extensionName}: Invalid backup index on button.`);
            toastr.error(t('无法读取备份索引。'));
        }
    });

    // --- 5. Register SillyTavern event listeners ---
    const eventsToTriggerBackup = [
        event_types.MESSAGE_SENT,
        event_types.GENERATION_ENDED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_DELETED,
    ];
    eventsToTriggerBackup.forEach(eventType => {
        eventSource.on(eventType, triggerBackup);
    });

    // Handle chat switching
    eventSource.on(event_types.CHAT_CHANGED, () => {
        // Cancel any pending backup from the *previous* chat context
        if (typeof debouncedBackup.cancel === 'function') {
            debouncedBackup.cancel();
        }
        updateStatus(extension_settings[extensionName]?.isEnabled ? t('等待聊天活动...') : t('备份已禁用'));
        // No need to refresh display here, backups are global
    });

    // --- 6. Final Log ---
    console.log(`插件 ${extensionName} 已加载并初始化。`);
}); // jQuery Ready End
