// Chat Auto Backup 插件 - 自动保存和恢复最近三次聊天记录
// 主要功能：
// 1. 自动保存最近三次聊天记录
// 2. 在插件页面显示保存的记录
// 3. 提供恢复功能，将保存的聊天记录恢复到新的聊天中

import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
} from '../../../extensions.js';

import {
    saveSettingsDebounced,
} from '../../../../script.js';

// 使用更高效的 structuredClone 进行深拷贝
// 避免使用 JSON.parse(JSON.stringify())，提高性能
const deepCopy = (obj) => {
    try {
        return structuredClone(obj);
    } catch (error) {
        console.warn('[聊天自动备份] structuredClone 失败，回退到 JSON 方法', error);
        return JSON.parse(JSON.stringify(obj));
    }
};

// 扩展名和设置初始化
const PLUGIN_NAME = 'chat-auto-backup';
const DEFAULT_SETTINGS = {
    maxBackupsPerChat: 3,  // 每个聊天保存的最大备份数量
    backups: {},           // 保存的备份数据：{ chatKey: [backup1, backup2, ...] }
};

// 初始化插件设置
function initSettings() {
    if (!extension_settings[PLUGIN_NAME]) {
        extension_settings[PLUGIN_NAME] = DEFAULT_SETTINGS;
    }
    
    // 确保设置结构完整
    const settings = extension_settings[PLUGIN_NAME];
    if (settings.maxBackupsPerChat === undefined) {
        settings.maxBackupsPerChat = DEFAULT_SETTINGS.maxBackupsPerChat;
    }
    if (!settings.backups) {
        settings.backups = {};
    }
    
    return settings;
}

// 获取当前聊天的唯一标识符
function getCurrentChatKey() {
    const context = getContext();
    
    // 确定是角色聊天还是群组聊天
    if (context.groupId) {
        return `group_${context.groupId}_${context.chatId}`;
    } else if (context.characterId !== undefined) {
        return `char_${context.characterId}_${context.chatId}`;
    }
    
    return null;
}

// 获取当前聊天的名称信息（用于显示）
function getCurrentChatInfo() {
    const context = getContext();
    let chatName, entityName;
    
    // 获取聊天实体名称（角色名或群组名）
    if (context.groupId) {
        const group = context.groups.find(g => g.id === context.groupId);
        entityName = group ? group.name : '未知群组';
        chatName = context.chatId || '当前聊天';
    } else if (context.characterId !== undefined) {
        entityName = context.name2 || '未知角色';
        // 从角色聊天文件名中提取聊天名称
        const character = context.characters[context.characterId];
        if (character && character.chat) {
            chatName = character.chat.replace('.jsonl', '');
        } else {
            chatName = '当前聊天';
        }
    } else {
        entityName = '未知';
        chatName = '当前聊天';
    }
    
    return { entityName, chatName };
}

// 执行聊天备份
function performBackup() {
    const chatKey = getCurrentChatKey();
    if (!chatKey) return; // 如果没有有效的聊天，不执行备份
    
    const context = getContext();
    const { chat } = context;
    
    // 如果聊天为空，不执行备份
    if (!chat || chat.length === 0) return;
    
    const settings = extension_settings[PLUGIN_NAME];
    const { entityName, chatName } = getCurrentChatInfo();
    
    // 准备备份数据
    const lastMsgIndex = chat.length - 1;
    const lastMessage = chat[lastMsgIndex];
    const lastMessagePreview = lastMessage?.mes?.substring(0, 100) || '(空消息)';
    
    const backup = {
        timestamp: Date.now(),
        chatKey,
        entityName,
        chatName,
        lastMessageId: lastMsgIndex,
        lastMessagePreview,
        chat: deepCopy(chat),
        metadata: deepCopy(context.chat_metadata || {})
    };
    
    // 初始化此聊天的备份数组（如不存在）
    if (!settings.backups[chatKey]) {
        settings.backups[chatKey] = [];
    }
    
    // 检查是否已有相同的备份（基于最后消息ID）
    // 如果已存在，则用新备份替换旧备份
    const existingIndex = settings.backups[chatKey].findIndex(
        b => b.lastMessageId === lastMsgIndex
    );
    
    if (existingIndex >= 0) {
        settings.backups[chatKey][existingIndex] = backup;
    } else {
        // 添加新备份，确保不超过最大备份数
        settings.backups[chatKey].push(backup);
        if (settings.backups[chatKey].length > settings.maxBackupsPerChat) {
            settings.backups[chatKey].shift(); // 移除最旧的备份
        }
    }
    
    // 保存设置
    saveSettingsDebounced();
    console.log(`[聊天自动备份] 成功保存聊天备份：${entityName} - ${chatName}`);
}

// 创建防抖动的备份函数
function createDebouncedBackup() {
    let timeout;
    return function() {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            performBackup();
        }, 2000); // 2秒防抖动
    };
}

// 恢复聊天记录到新聊天
async function restoreBackup(backupData) {
    try {
        const context = getContext();
        
        // 确定是角色还是群组
        const isGroup = backupData.chatKey.startsWith('group_');
        const entityIdMatch = backupData.chatKey.match(isGroup ? /group_(\w+)_/ : /char_(\d+)_/);
        const entityId = entityIdMatch ? entityIdMatch[1] : null;
        
        if (!entityId) {
            throw new Error('无法从备份数据中提取角色/群组ID');
        }
        
        // 1. 选择对应的角色/群组
        if (isGroup) {
            // 如果是群组，切换到该群组
            await context.openGroupChat(entityId);
        } else {
            // 如果是角色，切换到该角色
            const charId = parseInt(entityId);
            if (isNaN(charId)) throw new Error('无效的角色ID');
            
            // 使用角色选择函数
            // 注意：这里使用了SillyTavern的API，可能需要调整
            await jQuery.ajax({
                type: 'POST',
                url: '/api/characters/select',
                data: JSON.stringify({ character_id: charId }),
                contentType: 'application/json',
                dataType: 'json',
                beforeSend: (xhr) => {
                    const headers = context.getRequestHeaders();
                    if (headers) {
                        Object.entries(headers).forEach(([key, value]) => {
                            xhr.setRequestHeader(key, value);
                        });
                    }
                }
            });
        }
        
        // 2. 创建新聊天（使用doNewChat）
        if (isGroup) {
            // 群组创建新聊天
            await jQuery.ajax({
                type: 'POST',
                url: `/api/groups/chats/${entityId}/create`,
                beforeSend: (xhr) => {
                    const headers = context.getRequestHeaders();
                    if (headers) {
                        Object.entries(headers).forEach(([key, value]) => {
                            xhr.setRequestHeader(key, value);
                        });
                    }
                }
            });
        } else {
            // 角色创建新聊天
            await jQuery.ajax({
                type: 'POST',
                url: '/api/characters/chats/create',
                beforeSend: (xhr) => {
                    const headers = context.getRequestHeaders();
                    if (headers) {
                        Object.entries(headers).forEach(([key, value]) => {
                            xhr.setRequestHeader(key, value);
                        });
                    }
                }
            });
        }
        
        // 3. 恢复聊天内容
        // 清空当前聊天
        context.chat.length = 0;
        
        // 恢复聊天消息
        const restoredChat = [...backupData.chat];
        restoredChat.forEach(msg => {
            context.chat.push(msg);
        });
        
        // 恢复元数据
        if (backupData.metadata) {
            context.updateChatMetadata(backupData.metadata, true);
        }
        
        // 4. 保存恢复的聊天
        await context.saveChatConditional();
        
        // 5. 重新加载聊天显示
        // 首先清空聊天界面
        $('#chat').empty();
        
        // 根据显示规则显示消息
        // 这里模仿SillyTavern的printMessages行为
        // 但由于无法直接调用，我们使用公开的事件来触发重绘
        context.eventSource.emit('chatLoaded');
        
        console.log('[聊天自动备份] 聊天恢复成功');
        return true;
    } catch (error) {
        console.error('[聊天自动备份] 恢复聊天失败:', error);
        return false;
    }
}

// 更新插件设置页面UI
async function updateBackupsList() {
    const settings = extension_settings[PLUGIN_NAME];
    const backupsContainer = $('#chat_backup_list');
    if (!backupsContainer.length) return;
    
    backupsContainer.empty();
    
    // 获取所有备份的平面列表
    const allBackups = [];
    Object.values(settings.backups).forEach(chatBackups => {
        chatBackups.forEach(backup => {
            allBackups.push(backup);
        });
    });
    
    // 按时间降序排序
    allBackups.sort((a, b) => b.timestamp - a.timestamp);
    
    if (allBackups.length === 0) {
        backupsContainer.append('<div class="backup_empty_notice">暂无保存的备份</div>');
        return;
    }
    
    // 创建备份列表
    allBackups.forEach(backup => {
        const date = new Date(backup.timestamp);
        const formattedDate = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
        
        const backupItem = $(`
            <div class="backup_item">
                <div class="backup_info">
                    <div class="backup_header">
                        <span class="backup_entity">${backup.entityName}</span>
                        <span class="backup_chat">${backup.chatName}</span>
                        <span class="backup_mesid">消息数: ${backup.lastMessageId + 1}</span>
                        <span class="backup_date">${formattedDate}</span>
                    </div>
                    <div class="backup_preview">${backup.lastMessagePreview}...</div>
                </div>
                <div class="backup_actions">
                    <button class="menu_button backup_restore" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">恢复</button>
                </div>
            </div>
        `);
        
        backupsContainer.append(backupItem);
    });
    
    // 为恢复按钮绑定事件
    $('.backup_restore').on('click', async function() {
        const timestamp = $(this).data('timestamp');
        const chatKey = $(this).data('key');
        
        // 查找对应的备份数据
        const chatBackups = settings.backups[chatKey] || [];
        const backup = chatBackups.find(b => b.timestamp === timestamp);
        
        if (backup) {
            // 显示确认对话框
            if (confirm(`确定要恢复"${backup.entityName} - ${backup.chatName}"的备份吗？将会创建一个新的聊天。`)) {
                const success = await restoreBackup(backup);
                if (success) {
                    toastr.success('聊天记录已成功恢复到新聊天');
                } else {
                    toastr.error('恢复失败，请查看控制台获取详细信息');
                }
            }
        } else {
            toastr.error('找不到指定的备份');
        }
    });
}

// 初始化插件
jQuery(async () => {
    console.log('[聊天自动备份] 插件加载中...');
    
    // 初始化设置
    const settings = initSettings();
    
    try {
        // 加载插件UI
        const settingsHtml = await renderExtensionTemplateAsync(
            `third-party/${PLUGIN_NAME}`, 
            'settings'
        );
        
        // 将设置UI添加到扩展页面
        $('#extensions_settings').append(settingsHtml);
        
        // 初始化备份列表
        await updateBackupsList();
        
        // 创建防抖动的备份函数
        const debouncedBackup = createDebouncedBackup();
        
        // 监听聊天更新事件进行自动备份
        const context = getContext();
        context.eventSource.on('chatUpdated', () => {
            debouncedBackup();
        });
        
        // 监听消息发送事件进行自动备份
        context.eventSource.on('messageSent', () => {
            debouncedBackup();
        });
        
        // 每次扩展页面打开时刷新备份列表
        $('#extensionsMenuButton').on('click', () => {
            setTimeout(updateBackupsList, 100);
        });
        
        console.log('[聊天自动备份] 插件加载完成');
    } catch (error) {
        console.error('[聊天自动备份] 插件加载失败:', error);
    }
});
