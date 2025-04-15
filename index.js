// public/extensions/third-party/global-chat-history/index.js

// ==========================================================
// 1. 导入 SillyTavern 提供的模块和函数
// ==========================================================
// 核心脚本导入 (路径可能需要根据 ST 版本调整)
import {
    // 上下文与核心数据
    getContext,
    chat,
    chat_metadata,
    name1,
    name2,
    this_chid,
    selected_group,
    characters,
    groups,
    // 聊天控制函数
    selectCharacterById,
    doNewChat,
    printMessages,
    saveChatConditional,
    reloadCurrentChat,
    // 设置与事件
    extension_settings,
    saveSettingsDebounced,
    eventSource,
    event_types,
    // 工具函数
    t,
} from '../../../../script.js';

// 扩展相关函数 (路径可能需要根据 ST 版本调整)
import {
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

// 群组相关函数 (路径可能需要根据 ST 版本调整, 且确保函数已导出)
// 确保这些函数在你的 SillyTavern 版本中确实存在于 group-chats.js 并被导出
// 如果不确定或不需要群组支持，可以先注释掉这部分导入和相关逻辑
import {
    openGroupById,
    createNewGroupChat,
} from '../../../../group-chats.js'; // 示例路径，请核实

// 其他工具 (路径可能需要根据 ST 版本调整)
import { debounce } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';

// 假设 localforage 和 toastr 在 ST 环境中全局可用

// ==========================================================
// 2. 插件常量与设置
// ==========================================================
const extensionName = "global-chat-history";
const defaultSettings = {
    isEnabled: true,
};
const MAX_BACKUPS = 3;
const STORAGE_KEY = "st_global_chat_backups";
const BACKUP_DEBOUNCE_TIME = debounce_timeout.relaxed;

// ==========================================================
// 3. 加载插件设置
// ==========================================================
/**
 * 加载或初始化插件设置，并更新 UI
 */
async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    Object.assign(extension_settings[extensionName], {
        ...defaultSettings,
        ...extension_settings[extensionName],
    });

    $('#global-backup-enabled').prop('checked', extension_settings[extensionName].isEnabled);
    updateBackupStatus();
}

/**
 * 更新设置界面中的状态显示文本
 * @param {string} [message] - 要直接显示的消息，如果为空则根据当前状态判断
 */
function updateBackupStatus(message = '') {
    const statusEl = $('#global-backup-status');
    if (!statusEl.length) return;

    if (message) {
        statusEl.text(message);
        return;
    }

    if (!extension_settings[extensionName]?.isEnabled) {
        statusEl.text(t('备份已禁用'));
    } else {
        localforage.getItem(STORAGE_KEY).then(backups => {
            if (Array.isArray(backups) && backups.length > 0 && backups[0].timestamp) {
                statusEl.text(`${t('上次备份:')} ${new Date(backups[0].timestamp).toLocaleString()}`);
            } else {
                statusEl.text(t('等待聊天活动...'));
            }
        }).catch(() => {
             statusEl.text(t('等待聊天活动...'));
        });
    }
}

// ==========================================================
// 4. 核心备份函数 (`performBackup`) - 全局列表管理
// ==========================================================
/**
 * 执行实际的备份操作，管理全局备份列表
 */
async function performBackup() {
    const settings = extension_settings[extensionName];
    if (!settings.isEnabled) {
        console.log(`${extensionName}: Backup is disabled.`);
        updateBackupStatus();
        return;
    }

    const context = getContext();
    let sourceType = null;
    let sourceId = null;
    let sourceName = '';
    let chatName = '';

    if (context.selected_group) {
        sourceType = 'group';
        sourceId = context.selected_group;
        const group = context.groups?.find(g => g.id === sourceId);
        if (!group) {
            console.warn(`${extensionName}: Active group ${sourceId} not found.`);
            return;
        }
        sourceName = group.name;
        chatName = group.chat_id;
    } else if (context.this_chid !== undefined && context.this_chid !== null) {
        sourceType = 'character';
        sourceId = context.this_chid;
        const character = context.characters?.[sourceId];
        if (!character) {
             console.warn(`${extensionName}: Active character ${sourceId} not found.`);
             return;
        }
        sourceName = character.name;
        chatName = character.chat;
    } else {
        console.log(`${extensionName}: No active character or group selected, skipping backup.`);
        updateBackupStatus(t('无活动聊天'));
        return;
    }

    let currentChat;
    let currentMetadata;
    try {
        currentChat = structuredClone(chat);
        currentMetadata = structuredClone(chat_metadata);
    } catch (e) {
        console.warn(`${extensionName}: structuredClone failed, falling back to JSON method. Error: ${e}`);
        try {
            currentChat = JSON.parse(JSON.stringify(chat));
            currentMetadata = JSON.parse(JSON.stringify(chat_metadata));
        } catch (jsonError) {
            console.error(`${extensionName}: Failed to deep copy chat data using JSON method. Backup aborted.`, jsonError);
            toastr.error(t('无法复制聊天数据，备份中止。'));
            updateBackupStatus(t('备份失败 (复制错误)!'));
            return;
        }
    }

    if (!currentChat || currentChat.length === 0) {
        console.log(`${extensionName}: Chat is empty, skipping backup for ${sourceType} ${sourceId}.`);
        updateBackupStatus(t('聊天为空，跳过'));
        return;
    }

    const lastMessageIndex = currentChat.length - 1;
    const lastMessage = currentChat[lastMessageIndex];
    const lastMessagePreview = lastMessage?.mes?.substring(0, 100) || '';

    const newBackup = {
        timestamp: Date.now(),
        sourceType: sourceType,
        sourceId: sourceId,
        sourceName: sourceName,
        chatName: chatName,
        lastMessageId: lastMessageIndex,
        lastMessagePreview: lastMessagePreview,
        chat: currentChat,
        metadata: currentMetadata,
    };

    console.log(`${extensionName}: Preparing backup for ${sourceType}: ${sourceName} (${chatName})`);
    updateBackupStatus(t('准备备份...'));

    try {
        let backups = await localforage.getItem(STORAGE_KEY) || [];
        if (!Array.isArray(backups)) {
            console.warn(`${extensionName}: Invalid data found for ${STORAGE_KEY}, resetting backup list.`);
            backups = [];
        }

        backups.unshift(newBackup);

        if (backups.length > MAX_BACKUPS) {
            backups = backups.slice(0, MAX_BACKUPS);
        }

        await localforage.setItem(STORAGE_KEY, backups);
        console.log(`${extensionName}: Backup successful. Total global backups: ${backups.length}`);
        updateBackupStatus(`${t('上次备份:')} ${new Date(newBackup.timestamp).toLocaleString()}`);

        if ($('#global-backup-settings').length) {
             displayBackups();
        }

    } catch (error) {
        console.error(`${extensionName}: Error performing backup:`, error);
        toastr.error(`${t('备份聊天失败')}: ${error.message}`, `${extensionName}`);
        updateBackupStatus(t('备份失败!'));

        if (error && error.name === 'QuotaExceededError') {
            settings.isEnabled = false;
            $('#global-backup-enabled').prop('checked', false);
            saveSettingsDebounced();
            callGenericPopup(t('浏览器存储空间已满，聊天备份插件已被禁用。请清理浏览器存储或手动删除旧备份。'), POPUP_TYPE.TEXT);
            updateBackupStatus();
        }
    }
}

// ==========================================================
// 5. 防抖处理与事件触发
// ==========================================================
const debouncedBackup = debounce(performBackup, BACKUP_DEBOUNCE_TIME);

function triggerBackup() {
    if (extension_settings[extensionName]?.isEnabled) {
        console.debug(`${extensionName}: Backup triggered, debouncing...`);
        debouncedBackup();
    }
}

// ==========================================================
// 6. 显示备份列表 (`displayBackups`)
// ==========================================================
/**
 * 从 localForage 加载全局备份列表并在设置界面中显示
 */
async function displayBackups() {
    const container = $('#global-backup-list-container');
    if (!container.length) return;

    container.html(`<p>${t('正在加载备份...')}</p>`);

    try {
        const backups = await localforage.getItem(STORAGE_KEY) || [];
        if (!Array.isArray(backups)) {
             console.warn(`${extensionName}: Invalid backup data format found.`);
             container.html(`<p>${t('加载备份失败 (数据格式错误)。')}</p>`);
             return;
        }

        if (backups.length === 0) {
            container.html(`<p>${t('暂无备份记录。')}</p>`);
            return;
        }

        let backupHtml = '';
        backups.forEach((backup, index) => {
            if (!backup || typeof backup !== 'object' || !backup.timestamp || !backup.sourceType || backup.sourceId === undefined || !backup.sourceName) {
                console.warn(`${extensionName}: Skipping invalid backup item at index ${index}.`, backup);
                return;
            }

            const dateStr = new Date(backup.timestamp).toLocaleString();
            const typeStr = backup.sourceType === 'character' ? t('角色') : t('群组');
            const preview = backup.lastMessagePreview ? escapeHtml(backup.lastMessagePreview) + '...' : `(${t('无预览')})`;

            backupHtml += `
                <div class="backup-item">
                    <div class="backup-info">
                        <span class="backup-source">${typeStr}: <b>${escapeHtml(backup.sourceName)}</b></span>
                        <span class="backup-chat">(${escapeHtml(backup.chatName || 'N/A')})</span>
                        <span class="backup-time">${dateStr}</span>
                        <span class="backup-id">(ID: ${backup.lastMessageId})</span>
                    </div>
                    <div class="backup-preview">${preview}</div>
                    <div class="backup-actions">
                        <button class="menu_button restore-backup" data-backup-index="${index}" title="${t('恢复此备份 (将创建新聊天)')}">
                            <i class="fa-solid fa-clock-rotate-left"></i> ${t('恢复')}
                        </button>
                    </div>
                </div>
            `;
        });

        container.html(backupHtml || `<p>${t('暂无有效备份记录。')}</p>`);

    } catch (error) {
        console.error(`${extensionName}: Error displaying backups:`, error);
        container.html(`<p>${t('加载备份列表时出错。')}</p>`);
        toastr.error(t('加载备份列表失败。'));
    }
}

/**
 * 简单的 HTML 转义函数，防止 XSS 攻击
 * @param {string} unsafe - 可能包含 HTML 特殊字符的字符串
 * @returns {string} 转义后的安全字符串
 */
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe
         .replace(/&/g, "&")
         .replace(/</g, "<")
         .replace(/>/g, ">")
         .replace(/"/g, """)
         .replace(/'/g, "'");
 }


// ==========================================================
// 7. 恢复功能 (`restoreBackup`)
// ==========================================================
/**
 * 根据提供的备份索引，执行恢复操作
 * @param {number} backupIndex - 要恢复的备份在全局列表中的索引
 */
async function restoreBackup(backupIndex) {
     console.log(`${extensionName}: Restore requested for backup index ${backupIndex}`);
     let backups;
     let backupData;

     try {
        backups = await localforage.getItem(STORAGE_KEY) || [];
        if (!Array.isArray(backups) || backupIndex < 0 || backupIndex >= backups.length) {
            toastr.error(t('无效的备份索引或无法加载备份列表。'));
            console.error(`${extensionName}: Invalid backup index or failed to load backups.`);
            return;
        }
        backupData = backups[backupIndex];

        if (!backupData || typeof backupData !== 'object' || !backupData.timestamp || !backupData.sourceType || backupData.sourceId === undefined || !backupData.chat || !backupData.metadata) {
             toastr.error(t('备份数据无效或不完整，无法恢复。'));
             console.error(`${extensionName}: Invalid or incomplete backup data at index ${backupIndex}.`, backupData);
             return;
        }

     } catch (error) {
         toastr.error(t('加载备份数据失败。'));
         console.error(`${extensionName}: Error loading backup data for restore:`, error);
         return;
     }

     const confirmMessage = `
         <h4>${t('确认恢复')}</h4>
         <p>${t('这将切换到 <b>{sourceName}</b> ({sourceType}) 并创建一个 <b>新聊天</b> 来恢复备份内容。此操作不可撤销。').replace('{sourceName}', escapeHtml(backupData.sourceName)).replace('{sourceType}', backupData.sourceType === 'character' ? t('角色') : t('群组'))}</p>
         <p>${t('备份时间:')} ${new Date(backupData.timestamp).toLocaleString()}</p>
     `;

     try {
        await callGenericPopup(confirmMessage, POPUP_TYPE.CONFIRM);
     } catch {
        console.log(`${extensionName}: Restore cancelled by user.`);
        toastr.info(t('恢复操作已取消。'));
        return;
     }

     console.log(`${extensionName}: User confirmed restore. Proceeding...`);
     updateBackupStatus(t('正在恢复...'));

     try {
         const { sourceType, sourceId, chat: backupChatArray, metadata: backupMetadata } = backupData;

         console.log(`${extensionName}: Switching context to ${sourceType} ${sourceId}...`);
         if (sourceType === 'character') {
             await selectCharacterById(sourceId);
         } else if (sourceType === 'group') {
             // 确保 openGroupById 函数可用并调用
             if (typeof openGroupById === 'function') {
                await openGroupById(sourceId);
             } else {
                 throw new Error('openGroupById function is not available.');
             }
         } else {
             throw new Error(`Unknown sourceType: ${sourceType}`);
         }
         await new Promise(res => setTimeout(res, 200));
         console.log(`${extensionName}: Context switched.`);

         console.log(`${extensionName}: Creating new chat...`);
         if (sourceType === 'character') {
             await doNewChat();
         } else if (sourceType === 'group') {
             // 确保 createNewGroupChat 函数可用并调用
             if (typeof createNewGroupChat === 'function') {
                await createNewGroupChat(sourceId);
             } else {
                 throw new Error('createNewGroupChat function is not available.');
             }
         }
         await new Promise(res => setTimeout(res, 200));
         console.log(`${extensionName}: New chat created.`);

         console.log(`${extensionName}: Injecting backup data...`);
         if (!Array.isArray(backupChatArray)) {
             throw new Error('Backup chat data is not an array.');
         }
         chat.splice(0, chat.length, ...backupChatArray);

         if (typeof backupMetadata !== 'object' || backupMetadata === null) {
             throw new Error('Backup metadata is not an object.');
         }
         Object.keys(chat_metadata).forEach(key => delete chat_metadata[key]);
         Object.assign(chat_metadata, backupMetadata);
         console.log(`${extensionName}: Data injected. Chat length: ${chat.length}`);

         console.log(`${extensionName}: Rendering messages...`);
         await printMessages(true);
         console.log(`${extensionName}: Messages rendered.`);

         console.log(`${extensionName}: Saving restored chat state...`);
         await saveChatConditional();
         console.log(`${extensionName}: Restored chat saved.`);

         toastr.success(t('聊天已成功从备份恢复到新会话中！'));
         updateBackupStatus(t('恢复成功'));

     } catch (error) {
         console.error(`${extensionName}: Error during restore process:`, error);
         toastr.error(`${t('恢复过程中发生错误:')} ${error.message}`);
         updateBackupStatus(t('恢复失败!'));
         // 可选：尝试恢复界面
         // if (typeof reloadCurrentChat === 'function') {
         //     await reloadCurrentChat();
         // }
     }
}

// ==========================================================
// 8. 清除备份功能
// ==========================================================
/**
 * 清除 localForage 中的所有聊天备份
 */
async function clearAllBackups() {
    try {
        await callGenericPopup(
            `<h4>${t('确认清除')}</h4><p>${t('这将永久删除所有已保存的聊天备份。此操作无法撤销。')}</p>`,
            POPUP_TYPE.CONFIRM
        );
    } catch {
        console.log(`${extensionName}: Clear backups cancelled by user.`);
        toastr.info(t('清除操作已取消。'));
        return;
    }

    try {
        console.log(`${extensionName}: Clearing all backups...`);
        await localforage.removeItem(STORAGE_KEY);
        console.log(`${extensionName}: All backups cleared.`);
        toastr.success(t('所有聊天备份已清除。'));
        displayBackups();
        updateBackupStatus();

    } catch (error) {
        console.error(`${extensionName}: Error clearing backups:`, error);
        toastr.error(t('清除备份时出错。'));
    }
}


// ==========================================================
// 9. 插件初始化 (jQuery(async () => { ... }))
// ==========================================================
jQuery(async () => {
    console.log(`Loading extension: ${extensionName}`);

    try {
        const settingsHtml = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'backup_display');
        $('#extensions_settings').append(settingsHtml);
    } catch (error) {
        console.error(`${extensionName}: Failed to load or inject HTML template:`, error);
        $('#extensions_settings').append(`<div style="color: red;">${t('插件 {extensionName} UI 加载失败。').replace('{extensionName}', extensionName)}</div>`);
        return;
    }

    await loadSettings();

    $('#global-backup-enabled').on('change', function () {
        extension_settings[extensionName].isEnabled = $(this).prop('checked');
        saveSettingsDebounced();
        updateBackupStatus();
        if (extension_settings[extensionName].isEnabled) {
            triggerBackup();
        }
    });

    $('#global-backup-refresh').on('click', displayBackups);
    $('#global-backup-clear').on('click', clearAllBackups);

    // 使用事件委托为恢复按钮绑定点击事件
    // 确保选择器正确指向列表容器内的按钮
    $('#extensions_settings').on('click', '#global-backup-list-container button.restore-backup', function () {
        const backupIndex = parseInt($(this).data('backup-index'), 10);
        if (!isNaN(backupIndex)) {
            restoreBackup(backupIndex);
        } else {
            console.error(`${extensionName}: Invalid backup index on button.`);
            toastr.error(t('无法识别的备份项目。'));
        }
    });


    displayBackups();

    const eventsToTriggerBackup = [
        event_types.MESSAGE_SENT,
        event_types.GENERATION_ENDED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_DELETED,
    ];

    eventsToTriggerBackup.forEach(eventType => {
        if (event_types[eventType]) {
            eventSource.on(event_types[eventType], triggerBackup);
        } else {
            console.warn(`${extensionName}: Event type "${eventType}" not found in event_types. Skipping listener.`);
        }
    });

     // 监听聊天切换事件
     if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            if (typeof debouncedBackup.cancel === 'function') {
                debouncedBackup.cancel();
                console.debug(`${extensionName}: Chat changed, cancelled pending backup.`);
            }
            updateBackupStatus();
        });
     } else {
         // 简化 console.warn 调用
         console.warn(extensionName + ': Event type "CHAT_CHANGED" not found in event_types. Skipping chat change listener.');
     }


    console.log(`Plugin ${extensionName} loaded and initialized.`);
}); // jQuery Ready End
