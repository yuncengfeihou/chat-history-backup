// 导入SillyTavern API
import {
    getContext,
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    getCurrentChatId,
    chat, 
    chat_metadata,
    openCharacterChat,
    openGroupChat,
    characters,
    getRequestHeaders,
    callPopup,
    substituteParams,
} from '../../../../script.js';

import { debounce } from '../../../utils.js';
import { faviconCache } from '../../../../script.js';

// 插件名称和常量
const extensionName = "chat-history-backup";
// 存储键前缀
const STORAGE_KEY_PREFIX = "st_chat_history_backup_";
// 最多保留多少个备份
const DEFAULT_MAX_BACKUPS = 3;
// 默认设置
const defaultSettings = {
    enabled: true,
    maxBackupsPerChat: DEFAULT_MAX_BACKUPS
};

// 全局变量
let backupWorker = null;
let isBackupInProgress = false;

// 初始化插件设置
function loadSettings() {
    // 确保设置对象存在
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    
    // 应用默认设置
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }
    
    // 更新UI
    $('#chat_history_enabled').prop('checked', extension_settings[extensionName].enabled);
    $('#chat_history_max_backups').val(extension_settings[extensionName].maxBackupsPerChat);
}

// 创建并初始化Web Worker
function initBackupWorker() {
    try {
        // 如果已经存在，先终止
        if (backupWorker) {
            backupWorker.terminate();
        }
        
        // 创建新的Worker
        backupWorker = new Worker(`/scripts/extensions/third-party/${extensionName}/backup-worker.js`);
        
        // 监听Worker消息
        backupWorker.onmessage = function(event) {
            const response = event.data;
            isBackupInProgress = false;
            
            if (response.success) {
                // 更新状态显示
                const formattedTime = new Date(response.backupInfo.timestamp).toLocaleTimeString();
                $('#chat_history_status').text(`上次备份: ${formattedTime}`);
                
                // 刷新备份列表
                loadBackupRecords();
            } else {
                console.error(`${extensionName}: Backup failed: `, response.error);
                $('#chat_history_status').text(`备份失败: ${response.error}`);
            }
        };
        
        backupWorker.onerror = function(error) {
            console.error(`${extensionName}: Worker error: `, error);
            isBackupInProgress = false;
            $('#chat_history_status').text('备份出错，请查看控制台');
        };
        
        console.log(`${extensionName}: Backup worker initialized`);
    } catch (error) {
        console.error(`${extensionName}: Failed to initialize backup worker:`, error);
        $('#chat_history_status').text('Web Worker初始化失败');
    }
}

// 执行备份操作
async function performBackup() {
    // 检查是否已启用
    if (!extension_settings[extensionName].enabled) {
        console.log(`${extensionName}: Backup is disabled`);
        return;
    }
    
    // 避免并发备份
    if (isBackupInProgress) {
        console.log(`${extensionName}: Backup already in progress, skipping`);
        return;
    }
    
    isBackupInProgress = true;
    $('#chat_history_status').text('正在备份...');
    
    // 获取当前聊天ID
    const currentChatId = getCurrentChatId();
    if (!currentChatId) {
        console.log(`${extensionName}: No active chat ID found`);
        $('#chat_history_status').text('无活动聊天');
        isBackupInProgress = false;
        return;
    }
    
    // 如果聊天记录为空，不进行备份
    if (!chat || chat.length === 0) {
        console.log(`${extensionName}: Chat is empty, skipping backup`);
        $('#chat_history_status').text('聊天为空，跳过备份');
        isBackupInProgress = false;
        return;
    }
    
    // 构建存储键
    const storageKey = `${STORAGE_KEY_PREFIX}${currentChatId}`;
    
    try {
        if (backupWorker) {
            // 使用Worker执行备份
            backupWorker.postMessage({
                chat: chat,
                metadata: chat_metadata,
                storageKey: storageKey,
                maxBackups: extension_settings[extensionName].maxBackupsPerChat
            });
        } else {
            // Worker不可用时的回退方案：在主线程执行
            console.warn(`${extensionName}: Worker not available, falling back to main thread backup`);
            await performBackupInMainThread(storageKey);
        }
    } catch (error) {
        console.error(`${extensionName}: Backup error:`, error);
        $('#chat_history_status').text(`备份错误: ${error.message || 'Unknown error'}`);
        isBackupInProgress = false;
    }
}

// 主线程备份方案(备用)
async function performBackupInMainThread(storageKey) {
    try {
        // 从localforage获取现有备份
        let backups = await localforage.getItem(storageKey) || [];
        
        // 确保获取到的是数组
        if (!Array.isArray(backups)) {
            backups = [];
        }
        
        // 获取角色/群组信息
        const characterName = chat_metadata.character_name || '未知角色';
        const groupName = chat_metadata.group_name || null;
        const chatTitle = chat_metadata.chat_title || '未命名聊天';
        const lastMessageId = chat.length > 0 ? chat[chat.length - 1].id || 0 : 0;
        
        // 创建消息预览
        let lastMessagePreview = '';
        if (chat.length > 0) {
            const lastMessage = chat[chat.length - 1];
            lastMessagePreview = lastMessage.mes || '';
            if (lastMessagePreview.length > 100) {
                lastMessagePreview = lastMessagePreview.substring(0, 100) + '...';
            }
        }
        
        // 创建新备份
        const newBackup = {
            timestamp: Date.now(),
            chat: structuredClone(chat),
            metadata: structuredClone(chat_metadata),
            info: {
                entityName: groupName || characterName,
                chatTitle: chatTitle,
                lastMessageId: lastMessageId,
                messageCount: chat.length,
                lastMessagePreview: lastMessagePreview,
                isGroup: !!groupName
            }
        };
        
        // 添加到备份列表顶部
        backups.unshift(newBackup);
        
        // 保留最多maxBackups个备份
        if (backups.length > extension_settings[extensionName].maxBackupsPerChat) {
            backups = backups.slice(0, extension_settings[extensionName].maxBackupsPerChat);
        }
        
        // 保存备份
        await localforage.setItem(storageKey, backups);
        
        // 更新状态
        const formattedTime = new Date(newBackup.timestamp).toLocaleTimeString();
        $('#chat_history_status').text(`上次备份: ${formattedTime}`);
        
        // 刷新备份列表
        loadBackupRecords();
        isBackupInProgress = false;
        
    } catch (error) {
        console.error(`${extensionName}: Main thread backup failed:`, error);
        $('#chat_history_status').text(`备份失败: ${error.message}`);
        isBackupInProgress = false;
        throw error;
    }
}

// 加载备份记录并显示在UI中
async function loadBackupRecords() {
    const currentChatId = getCurrentChatId();
    if (!currentChatId) {
        $('#chat_history_records_container').html('<div class="no_records_message">暂无活动聊天</div>');
        return;
    }
    
    const storageKey = `${STORAGE_KEY_PREFIX}${currentChatId}`;
    
    try {
        const backups = await localforage.getItem(storageKey) || [];
        
        if (!backups || backups.length === 0) {
            $('#chat_history_records_container').html('<div class="no_records_message">暂无保存的聊天记录</div>');
            return;
        }
        
        // 构建备份记录HTML
        let recordsHtml = '';
        
        for (let i = 0; i < backups.length; i++) {
            const backup = backups[i];
            const timestamp = new Date(backup.timestamp);
            const formattedTime = timestamp.toLocaleString();
            const info = backup.info || {};
            
            recordsHtml += `
            <div class="backup_record" data-index="${i}">
                <div class="backup_record_header">
                    <div class="backup_record_title">${info.entityName || 'Unknown'} - ${info.chatTitle || 'Unnamed Chat'}</div>
                    <div class="backup_record_time">${formattedTime}</div>
                </div>
                <div class="backup_record_info">消息数: ${info.messageCount || '?'} | 最后消息ID: ${info.lastMessageId || '?'}</div>
                <div class="backup_record_preview">${info.lastMessagePreview || 'No preview available'}</div>
                <div class="backup_record_actions">
                    <button class="restore_button" data-index="${i}">[恢复]</button>
                </div>
            </div>`;
        }
        
        $('#chat_history_records_container').html(recordsHtml);
    } catch (error) {
        console.error(`${extensionName}: Failed to load backup records:`, error);
        $('#chat_history_records_container').html(`<div class="no_records_message">加载备份记录失败: ${error.message}</div>`);
    }
}

// 从备份恢复聊天
async function restoreFromBackup(backup) {
    if (!backup || !backup.chat || !backup.metadata) {
        console.error(`${extensionName}: Invalid backup data for restore`);
        return false;
    }
    
    try {
        // 确认恢复
        const confirmResult = await callPopup('确定要从此备份恢复聊天吗？这将创建一个新的聊天并恢复所有消息。', 'confirm');
        if (!confirmResult) return false;
        
        // 获取角色/群组信息
        const isGroup = backup.info?.isGroup || false;
        const entityName = backup.info?.entityName || backup.metadata.character_name || 'Unknown';
        
        if (isGroup) {
            // 查找群组ID
            const groupId = findGroupIdByName(entityName);
            if (!groupId) {
                console.error(`${extensionName}: Could not find group: ${entityName}`);
                callPopup(`恢复失败: 找不到群组 "${entityName}"`, 'text');
                return false;
            }
            
            // 打开群组聊天
            await openGroupChat(groupId);
        } else {
            // 查找角色
            const character = findCharacterByName(entityName);
            if (!character) {
                console.error(`${extensionName}: Could not find character: ${entityName}`);
                callPopup(`恢复失败: 找不到角色 "${entityName}"`, 'text');
                return false;
            }
            
            // 打开角色聊天
            await openCharacterChat(character.avatar);
        }
        
        // 短暂延迟确保聊天已加载
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // 使用showMoreMessages的方式批量加载消息
        await restoreMessages(backup.chat);
        
        // 显示成功消息
        callPopup('聊天恢复成功!', 'text');
        return true;
    } catch (error) {
        console.error(`${extensionName}: Error restoring from backup:`, error);
        callPopup(`恢复失败: ${error.message || 'Unknown error'}`, 'text');
        return false;
    }
}

// 按照showMoreMessages的方式恢复消息
async function restoreMessages(messageArray) {
    if (!Array.isArray(messageArray) || messageArray.length === 0) {
        return;
    }
    
    // 清空现有chat数组并准备填充新内容
    chat.length = 0;
    
    // 将备份中的所有消息加入chat数组
    for (const message of messageArray) {
        chat.push(message);
    }
    
    // 使用printMessages重新渲染所有消息
    // 这个函数需要从SillyTavern的核心导入
    // 如果无法直接导入，可能需要使用事件或其他方式触发重新渲染
    
    // 此处模拟触发CHAT_CHANGED事件，让SillyTavern自行处理消息渲染
    eventSource.emit(event_types.CHAT_CHANGED);
    
    return true;
}

// 查找群组ID
function findGroupIdByName(groupName) {
    const context = getContext();
    const groups = context.groups || [];
    
    for (const id in groups) {
        if (groups[id].name === groupName) {
            return id;
        }
    }
    
    return null;
}

// 查找角色
function findCharacterByName(characterName) {
    const context = getContext();
    const chars = context.characters || characters || [];
    
    for (const char of chars) {
        if (char.name === characterName) {
            return char;
        }
    }
    
    return null;
}

// 使用debounce延迟执行备份
const triggerBackup = debounce(performBackup, 2000);

// ================ 事件处理 ================

// 绑定设置变更事件
function attachSettingsHandlers() {
    $('#chat_history_enabled').on('change', function() {
        extension_settings[extensionName].enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        
        if (extension_settings[extensionName].enabled) {
            triggerBackup();
        } else {
            $('#chat_history_status').text('备份已禁用');
        }
    });
    
    $('#chat_history_max_backups').on('change', function() {
        const value = parseInt($(this).val());
        if (!isNaN(value) && value >= 1) {
            extension_settings[extensionName].maxBackupsPerChat = value;
            saveSettingsDebounced();
        }
    });
    
    // 绑定恢复按钮点击事件（通过事件委托）
    $(document).on('click', '.restore_button', async function() {
        const index = parseInt($(this).data('index'));
        const currentChatId = getCurrentChatId();
        const storageKey = `${STORAGE_KEY_PREFIX}${currentChatId}`;
        
        try {
            const backups = await localforage.getItem(storageKey) || [];
            if (index >= 0 && index < backups.length) {
                await restoreFromBackup(backups[index]);
            }
        } catch (error) {
            console.error(`${extensionName}: Error handling restore:`, error);
        }
    });
}

// 插件初始化
jQuery(async () => {
    // 加载设置
    loadSettings();
    
    // 加载HTML模板
    try {
        const settingsHtml = await renderExtensionTemplateAsync('third-party/chat-history-backup', 'settings_display');
        $('#extensions_settings').append(settingsHtml);
    } catch (error) {
        console.error(`${extensionName}: Error loading settings template:`, error);
        $('#extensions_settings').append(`<div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>聊天历史自动保存与恢复</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div style="padding:10px">
                    <p>模板加载失败，请刷新页面重试。</p>
                </div>
            </div>
        </div>`);
    }
    
    // 初始化Web Worker
    initBackupWorker();
    
    // 绑定设置事件
    attachSettingsHandlers();
    
    // 监听事件触发备份
    eventSource.on(event_types.MESSAGE_SENT, triggerBackup);
    eventSource.on(event_types.MESSAGE_RECEIVED, triggerBackup);
    eventSource.on(event_types.MESSAGE_SWIPED, triggerBackup);
    eventSource.on(event_types.MESSAGE_EDITED, triggerBackup);
    
    // 监听聊天切换刷新备份列表
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(loadBackupRecords, 500); // 延迟加载，确保聊天已完全切换
    });
    
    // 初次加载备份列表
    setTimeout(loadBackupRecords, 1000);
    
    console.log(`${extensionName}: Plugin initialized`);
});
