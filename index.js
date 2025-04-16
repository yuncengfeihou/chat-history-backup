// Chat Auto Backup 插件 - 自动保存和恢复最近三次聊天记录
// 主要功能：
// 1. 自动保存最近三次聊天记录到IndexedDB
// 2. 在插件页面显示保存的记录
// 3. 提供恢复功能，将保存的聊天记录恢复到新的聊天中

import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
} from '../../../extensions.js';

import {
    saveSettingsDebounced, 
    eventSource,
    event_types,
} from '../../../../script.js';

// 使用更高效的 structuredClone 进行深拷贝
// 避免使用 JSON.parse(JSON.stringify())，提高性能
const deepCopy = (obj) => {
    try {
        console.log('[聊天自动备份] 开始执行深拷贝');
        return structuredClone(obj);
    } catch (error) {
        console.warn('[聊天自动备份] structuredClone 失败，回退到 JSON 方法', error);
        return JSON.parse(JSON.stringify(obj));
    }
};

// 扩展名和设置初始化
const PLUGIN_NAME = 'chat-history-backup';
const DEFAULT_SETTINGS = {
    maxBackupsPerChat: 3,  // 每个聊天保存的最大备份数量
    debug: true,           // 调试模式
};

// IndexedDB 数据库名称和版本
const DB_NAME = 'ST_ChatAutoBackup';
const DB_VERSION = 1;
const STORE_NAME = 'backups';

// 为调试目的添加日志函数
function logDebug(...args) {
    const settings = extension_settings[PLUGIN_NAME];
    if (settings && settings.debug) {
        console.log('[聊天自动备份]', ...args);
    }
}

// 初始化插件设置
function initSettings() {
    console.log('[聊天自动备份] 初始化插件设置');
    if (!extension_settings[PLUGIN_NAME]) {
        console.log('[聊天自动备份] 创建新的插件设置');
        extension_settings[PLUGIN_NAME] = DEFAULT_SETTINGS;
    }
    
    // 确保设置结构完整
    const settings = extension_settings[PLUGIN_NAME];
    if (settings.maxBackupsPerChat === undefined) {
        settings.maxBackupsPerChat = DEFAULT_SETTINGS.maxBackupsPerChat;
    }
    if (settings.debug === undefined) {
        settings.debug = DEFAULT_SETTINGS.debug;
    }
    
    console.log('[聊天自动备份] 插件设置初始化完成:', settings);
    return settings;
}

// 初始化 IndexedDB 数据库
function initDatabase() {
    return new Promise((resolve, reject) => {
        console.log('[聊天自动备份] 初始化 IndexedDB 数据库');
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = function(event) {
            console.error('[聊天自动备份] 打开数据库失败:', event.target.error);
            reject(event.target.error);
        };
        
        request.onsuccess = function(event) {
            const db = event.target.result;
            console.log('[聊天自动备份] 数据库打开成功');
            resolve(db);
        };
        
        request.onupgradeneeded = function(event) {
            const db = event.target.result;
            console.log('[聊天自动备份] 数据库升级中，创建对象存储');
            
            // 创建备份存储，使用复合键: [chatKey, timestamp]
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: ['chatKey', 'timestamp'] });
                // 创建索引以便按chatKey查询
                store.createIndex('chatKey', 'chatKey', { unique: false });
                console.log('[聊天自动备份] 创建了备份存储和索引');
            }
        };
    });
}

// 获取数据库连接
async function getDB() {
    try {
        return await initDatabase();
    } catch (error) {
        console.error('[聊天自动备份] 获取数据库连接失败:', error);
        throw error;
    }
}

// 保存备份到 IndexedDB
async function saveBackupToDB(backup) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            
            const request = store.put(backup);
            
            request.onsuccess = function() {
                logDebug(`备份已保存到IndexedDB, 键: [${backup.chatKey}, ${backup.timestamp}]`);
                resolve();
            };
            
            request.onerror = function(event) {
                console.error('[聊天自动备份] 保存备份失败:', event.target.error);
                reject(event.target.error);
            };
            
            transaction.oncomplete = function() {
                db.close();
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] saveBackupToDB 失败:', error);
        throw error;
    }
}

// 从 IndexedDB 获取指定聊天的所有备份
async function getBackupsForChat(chatKey) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('chatKey');
            
            const request = index.getAll(chatKey);
            
            request.onsuccess = function() {
                const backups = request.result || [];
                logDebug(`从IndexedDB获取了 ${backups.length} 个备份，chatKey: ${chatKey}`);
                resolve(backups);
            };
            
            request.onerror = function(event) {
                console.error('[聊天自动备份] 获取备份失败:', event.target.error);
                reject(event.target.error);
            };
            
            transaction.oncomplete = function() {
                db.close();
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getBackupsForChat 失败:', error);
        return [];
    }
}

// 从 IndexedDB 获取所有备份
async function getAllBackups() {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            
            const request = store.getAll();
            
            request.onsuccess = function() {
                const backups = request.result || [];
                logDebug(`从IndexedDB获取了总共 ${backups.length} 个备份`);
                resolve(backups);
            };
            
            request.onerror = function(event) {
                console.error('[聊天自动备份] 获取所有备份失败:', event.target.error);
                reject(event.target.error);
            };
            
            transaction.oncomplete = function() {
                db.close();
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getAllBackups 失败:', error);
        return [];
    }
}

// 从 IndexedDB 删除指定备份
async function deleteBackup(chatKey, timestamp) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            
            const request = store.delete([chatKey, timestamp]);
            
            request.onsuccess = function() {
                logDebug(`已从IndexedDB删除备份, 键: [${chatKey}, ${timestamp}]`);
                resolve();
            };
            
            request.onerror = function(event) {
                console.error('[聊天自动备份] 删除备份失败:', event.target.error);
                reject(event.target.error);
            };
            
            transaction.oncomplete = function() {
                db.close();
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] deleteBackup 失败:', error);
        throw error;
    }
}

// 获取当前聊天的唯一标识符
function getCurrentChatKey() {
    const context = getContext();
    logDebug('获取当前聊天标识符, context:', 
        {groupId: context.groupId, characterId: context.characterId, chatId: context.chatId});
    
    // 确定是角色聊天还是群组聊天
    if (context.groupId) {
        const key = `group_${context.groupId}_${context.chatId}`;
        logDebug('当前是群组聊天，chatKey:', key);
        return key;
    } else if (context.characterId !== undefined) {
        const key = `char_${context.characterId}_${context.chatId}`;
        logDebug('当前是角色聊天，chatKey:', key);
        return key;
    }
    
    console.warn('[聊天自动备份] 无法获取当前聊天的标识符，可能没有选择角色或群组');
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
        logDebug('获取到群组聊天信息:', {entityName, chatName});
    } else if (context.characterId !== undefined) {
        entityName = context.name2 || '未知角色';
        // 从角色聊天文件名中提取聊天名称
        const character = context.characters[context.characterId];
        if (character && character.chat) {
            chatName = character.chat.replace('.jsonl', '');
        } else {
            chatName = '当前聊天';
        }
        logDebug('获取到角色聊天信息:', {entityName, chatName});
    } else {
        entityName = '未知';
        chatName = '当前聊天';
        console.warn('[聊天自动备份] 无法获取聊天信息，使用默认值');
    }
    
    return { entityName, chatName };
}

// 执行聊天备份
async function performBackup() {
    console.log('[聊天自动备份] 开始执行聊天备份');
    
    const chatKey = getCurrentChatKey();
    if (!chatKey) {
        console.warn('[聊天自动备份] 无有效的聊天标识符，取消备份');
        return;
    }
    
    const context = getContext();
    const { chat } = context;
    
    // 如果聊天为空，不执行备份
    if (!chat || chat.length === 0) {
        console.warn('[聊天自动备份] 聊天记录为空，取消备份');
        return;
    }
    
    const settings = extension_settings[PLUGIN_NAME];
    const { entityName, chatName } = getCurrentChatInfo();
    
    logDebug(`开始备份聊天: ${entityName} - ${chatName}, 当前消息数量:`, chat.length);
    
    // 准备备份数据
    const lastMsgIndex = chat.length - 1;
    const lastMessage = chat[lastMsgIndex];
    const lastMessagePreview = lastMessage?.mes?.substring(0, 100) || '(空消息)';
    
    logDebug(`聊天最后一条消息索引: ${lastMsgIndex}, 预览:`, lastMessagePreview);
    
    try {
        // 执行深拷贝前记录内存使用情况
        if (performance && performance.memory) {
            logDebug('备份前内存使用:', performance.memory.usedJSHeapSize / (1024 * 1024), 'MB');
        }
        
        console.time('[聊天自动备份] 深拷贝执行时间');
        
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
        
        console.timeEnd('[聊天自动备份] 深拷贝执行时间');
        
        if (performance && performance.memory) {
            logDebug('备份后内存使用:', performance.memory.usedJSHeapSize / (1024 * 1024), 'MB');
        }
        
        // 获取现有备份
        const existingBackups = await getBackupsForChat(chatKey);
        
        // 检查是否已有相同的备份（基于最后消息ID）
        const existingBackup = existingBackups.find(b => b.lastMessageId === lastMsgIndex);
        
        if (existingBackup) {
            logDebug(`已存在相同ID的备份，删除旧备份并保存新备份`);
            await deleteBackup(chatKey, existingBackup.timestamp);
        }
        
        // 保存新备份到IndexedDB
        await saveBackupToDB(backup);
        
        // 确保每个聊天的备份数量不超过限制
        if (existingBackups.length + 1 > settings.maxBackupsPerChat) {
            // 按时间排序，保留最新的
            const sortedBackups = [...existingBackups].sort((a, b) => b.timestamp - a.timestamp);
            
            // 删除多余的旧备份
            for (let i = settings.maxBackupsPerChat - 1; i < sortedBackups.length; i++) {
                const oldBackup = sortedBackups[i];
                logDebug(`超出最大备份数限制，删除旧备份:`, 
                    {timestamp: new Date(oldBackup.timestamp).toLocaleString(), messageId: oldBackup.lastMessageId});
                await deleteBackup(chatKey, oldBackup.timestamp);
            }
        }
        
        // 在UI中显示提示
        if (settings.debug) {
            toastr.info(`已备份聊天: ${entityName} (${lastMsgIndex + 1}条消息)`, '聊天自动备份');
        }
        
        console.log(`[聊天自动备份] 成功保存聊天备份到IndexedDB：${entityName} - ${chatName} (${lastMsgIndex + 1}条消息)`);
    } catch (error) {
        console.error('[聊天自动备份] 备份过程中发生错误:', error);
    }
}

// 创建防抖动的备份函数
function createDebouncedBackup() {
    console.log('[聊天自动备份] 创建防抖动备份函数');
    let timeout;
    return function() {
        console.log('[聊天自动备份] 触发防抖动备份函数');
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            console.log('[聊天自动备份] 执行延迟的备份操作');
            performBackup();
        }, 2000); // 2秒防抖动
    };
}

// 添加手动备份功能
async function performManualBackup() {
    console.log('[聊天自动备份] 执行手动备份');
    await performBackup();
    toastr.success('已手动备份当前聊天到IndexedDB', '聊天自动备份');
    updateBackupsList();
}

// 恢复聊天记录到新聊天
async function restoreBackup(backupData) {
    try {
        console.log('[聊天自动备份] 开始恢复备份:', backupData);
        const context = getContext();
        
        // 确定是角色还是群组
        const isGroup = backupData.chatKey.startsWith('group_');
        const entityIdMatch = backupData.chatKey.match(isGroup ? /group_(\w+)_/ : /char_(\d+)_/);
        const entityId = entityIdMatch ? entityIdMatch[1] : null;
        
        if (!entityId) {
            console.error('[聊天自动备份] 无法从备份数据中提取角色/群组ID:', backupData.chatKey);
            throw new Error('无法从备份数据中提取角色/群组ID');
        }
        
        logDebug(`恢复备份: ${isGroup ? '群组' : '角色'} ID:${entityId}`);
        
        // 1. 选择对应的角色/群组
        if (isGroup) {
            // 如果是群组，切换到该群组
            logDebug(`切换到群组: ${entityId}`);
            await context.openGroupChat(entityId);
        } else {
            // 如果是角色，切换到该角色
            const charId = parseInt(entityId);
            if (isNaN(charId)) {
                console.error('[聊天自动备份] 无效的角色ID:', entityId);
                throw new Error('无效的角色ID');
            }
            
            logDebug(`切换到角色: ${charId}`);
            
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
        logDebug('创建新的聊天');
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
        
        // 等待一下确保新聊天创建完成
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // 3. 恢复聊天内容
        logDebug('开始恢复聊天消息, 消息数量:', backupData.chat.length);
        
        // 清空当前聊天
        context.chat.length = 0;
        
        // 恢复聊天消息
        const restoredChat = [...backupData.chat];
        restoredChat.forEach(msg => {
            context.chat.push(msg);
        });
        
        // 恢复元数据
        if (backupData.metadata) {
            logDebug('恢复聊天元数据:', backupData.metadata);
            context.updateChatMetadata(backupData.metadata, true);
        }
        
        // 4. 保存恢复的聊天
        logDebug('保存恢复的聊天');
        await context.saveChatConditional();
        
        // 5. 重新加载聊天显示
        // 首先清空聊天界面
        $('#chat').empty();
        
        // 根据显示规则显示消息
        // 这里模仿SillyTavern的printMessages行为
        // 但由于无法直接调用，我们使用公开的事件来触发重绘
        logDebug('触发聊天重新加载事件');
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
    logDebug('更新备份列表UI');
    const backupsContainer = $('#chat_backup_list');
    if (!backupsContainer.length) {
        console.warn('[聊天自动备份] 找不到备份列表容器元素 #chat_backup_list');
        return;
    }
    
    backupsContainer.empty();
    
    try {
        // 获取所有备份
        const allBackups = await getAllBackups();
        
        // 按时间降序排序
        allBackups.sort((a, b) => b.timestamp - a.timestamp);
        
        logDebug(`总备份数量: ${allBackups.length}`);
        
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
            const timestamp = parseInt($(this).data('timestamp'));
            const chatKey = $(this).data('key');
            
            logDebug(`点击恢复按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);
            
            try {
                // 从IndexedDB获取备份数据
                const db = await getDB();
                const transaction = db.transaction([STORE_NAME], 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                
                const request = store.get([chatKey, timestamp]);
                
                request.onsuccess = async function() {
                    const backup = request.result;
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
                        console.error('[聊天自动备份] 找不到指定的备份:', {timestamp, chatKey});
                        toastr.error('找不到指定的备份');
                    }
                };
                
                request.onerror = function(event) {
                    console.error('[聊天自动备份] 获取备份失败:', event.target.error);
                    toastr.error('获取备份失败');
                };
                
                transaction.oncomplete = function() {
                    db.close();
                };
            } catch (error) {
                console.error('[聊天自动备份] 恢复过程中出错:', error);
                toastr.error('恢复过程中出错');
            }
        });
    } catch (error) {
        console.error('[聊天自动备份] 更新备份列表失败:', error);
        backupsContainer.append(`<div class="backup_empty_notice">加载备份列表失败: ${error.message}</div>`);
    }
}

// 初始化插件
jQuery(async () => {
    console.log('[聊天自动备份] 插件加载中...');
    
    // 初始化设置
    const settings = initSettings();
    
    try {
        // 初始化数据库
        await initDatabase();
        
        // 加载插件UI
        const settingsHtml = await renderExtensionTemplateAsync(
            `third-party/${PLUGIN_NAME}`, 
            'settings'
        );
        
        // 将设置UI添加到扩展页面
        $('#extensions_settings').append(settingsHtml);
        console.log('[聊天自动备份] 已添加设置界面到扩展页面');
        
        // 初始化备份列表
        await updateBackupsList();
        
        // 为调试开关添加事件处理
        $('#chat_backup_debug_toggle').on('change', function() {
            settings.debug = $(this).prop('checked');
            console.log('[聊天自动备份] 调试模式已' + (settings.debug ? '启用' : '禁用'));
            saveSettingsDebounced();
        });
        
        // 更新调试开关状态
        $('#chat_backup_debug_toggle').prop('checked', settings.debug);
        
        // 为手动备份按钮添加事件处理
        $('#chat_backup_manual_backup').on('click', performManualBackup);
        
        // 创建防抖动的备份函数
        const debouncedBackup = createDebouncedBackup();
        
        // 枚举可用的ST事件
        console.log('[聊天自动备份] 可用事件类型:', event_types);
        
        // 监听聊天更新事件进行自动备份
        console.log('[聊天自动备份] 绑定事件: CHAT_CHANGED');
        eventSource.on(event_types.CHAT_CHANGED, () => {
            console.log('[聊天自动备份] 事件触发: CHAT_CHANGED');
            debouncedBackup();
        });
        
        // 监听消息接收事件
        console.log('[聊天自动备份] 绑定事件: MESSAGE_RECEIVED');
        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            console.log('[聊天自动备份] 事件触发: MESSAGE_RECEIVED');
            debouncedBackup();
        });
        
        // 监听消息发送事件进行自动备份
        console.log('[聊天自动备份] 绑定事件: MESSAGE_SENT');
        eventSource.on(event_types.MESSAGE_SENT, () => {
            console.log('[聊天自动备份] 事件触发: MESSAGE_SENT');
            debouncedBackup();
        });
        
        // 监听消息编辑事件
        console.log('[聊天自动备份] 绑定事件: MESSAGE_EDITED');
        eventSource.on(event_types.MESSAGE_EDITED, () => {
            console.log('[聊天自动备份] 事件触发: MESSAGE_EDITED');
            debouncedBackup();
        });
        
        // 监听消息删除事件
        console.log('[聊天自动备份] 绑定事件: MESSAGE_DELETED');
        eventSource.on(event_types.MESSAGE_DELETED, () => {
            console.log('[聊天自动备份] 事件触发: MESSAGE_DELETED');
            debouncedBackup();
        });
        
        // 每次扩展页面打开时刷新备份列表
        $('#extensionsMenuButton').on('click', () => {
            console.log('[聊天自动备份] 扩展菜单被点击，准备刷新备份列表');
            setTimeout(updateBackupsList, 100);
        });
        
        // 执行初始备份
        setTimeout(() => {
            console.log('[聊天自动备份] 执行初始备份检查');
            const context = getContext();
            if (context.chat && context.chat.length > 0) {
                console.log('[聊天自动备份] 发现现有聊天记录，执行初始备份');
                performBackup();
            } else {
                console.log('[聊天自动备份] 当前没有聊天记录，跳过初始备份');
            }
        }, 3000);
        
        console.log('[聊天自动备份] 插件加载完成');
    } catch (error) {
        console.error('[聊天自动备份] 插件加载失败:', error);
    }
});
