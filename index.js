// public/extensions/third-party/global-chat-history/index.js

// ==========================================================
// 1. 导入 SillyTavern 提供的模块和函数
// ==========================================================
// 核心脚本导入 (路径可能需要根据 ST 版本调整)
import {
    // 上下文与核心数据
    getContext,
    chat, // 当前聊天消息数组 (全局，会被修改)
    chat_metadata, // 当前聊天元数据 (全局，会被修改)
    name1, // 用户名
    name2, // 当前角色名 (注意: 群组时可能需特殊处理)
    this_chid, // 当前角色 ID
    selected_group, // 当前群组 ID
    characters, // 全局角色列表
    groups, // 全局群组列表
    // 聊天控制函数
    selectCharacterById, // 切换到角色
    doNewChat, // 为当前角色/群组创建新聊天
    printMessages, // 渲染聊天消息
    saveChatConditional, // 保存当前聊天
    reloadCurrentChat, // (可选) 重新加载当前聊天
    // 设置与事件
    extension_settings, // 插件设置对象
    saveSettingsDebounced, // 防抖保存设置
    eventSource, // 事件发射器
    event_types, // 事件类型常量
    // 工具函数
    t, // 国际化翻译
} from '../../../../script.js';

// 扩展相关函数 (路径可能需要根据 ST 版本调整)
import {
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

// 群组相关函数 (路径可能需要根据 ST 版本调整, 且确保函数已导出)
// 如果 openGroupById 和 createNewGroupChat 不在 script.js, 需要从这里导入
import {
    openGroupById,
    createNewGroupChat,
} from '../../../../group-chats.js'; // 示例路径，请核实

// 其他工具 (路径可能需要根据 ST 版本调整)
import { debounce } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';

// 假设 localforage 和 toastr 在 ST 环境中全局可用
// 通过 declare 告诉 TypeScript 或 JSDoc 它们的存在
declare var localforage: any;
declare var toastr: any;

// ==========================================================
// 2. 插件常量与设置
// ==========================================================
const extensionName = "global-chat-history"; // **必须**与插件文件夹名称一致!
const defaultSettings = {
    isEnabled: true, // 默认启用
};
const MAX_BACKUPS = 3; // 全局最多保留 3 个备份
const STORAGE_KEY = "st_global_chat_backups"; // 用于存储所有备份的唯一键
// 使用 'relaxed' 防抖，避免过于频繁的写入 (通常 1000ms)
const BACKUP_DEBOUNCE_TIME = debounce_timeout.relaxed;

// ==========================================================
// 3. 加载插件设置
// ==========================================================
/**
 * 加载或初始化插件设置，并更新 UI
 */
async function loadSettings() {
    // 确保插件设置对象存在
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    // 合并默认设置和已保存设置
    Object.assign(extension_settings[extensionName], {
        ...defaultSettings,
        ...extension_settings[extensionName],
    });

    // 更新设置界面中的复选框状态
    $('#global-backup-enabled').prop('checked', extension_settings[extensionName].isEnabled);
    // 更新状态显示文本
    updateBackupStatus();
}

/**
 * 更新设置界面中的状态显示文本
 * @param {string} [message] - 要直接显示的消息，如果为空则根据当前状态判断
 */
function updateBackupStatus(message = '') {
    const statusEl = $('#global-backup-status');
    if (!statusEl.length) return; // 如果 UI 元素不存在则退出

    if (message) {
        statusEl.text(message); // 直接显示传入的消息
        return;
    }

    // 根据插件启用状态和最新备份时间戳更新状态
    if (!extension_settings[extensionName]?.isEnabled) {
        statusEl.text(t('备份已禁用'));
    } else {
        // 尝试异步获取最新备份的时间戳
        localforage.getItem(STORAGE_KEY).then(backups => {
            if (Array.isArray(backups) && backups.length > 0 && backups[0].timestamp) {
                // 如果有备份，显示最新备份时间
                statusEl.text(`${t('上次备份:')} ${new Date(backups[0].timestamp).toLocaleString()}`);
            } else {
                // 没有备份，显示等待状态
                statusEl.text(t('等待聊天活动...'));
            }
        }).catch(() => {
             // 获取失败也显示等待状态
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
    // 检查插件是否启用
    if (!settings.isEnabled) {
        console.log(`${extensionName}: Backup is disabled.`);
        updateBackupStatus(); // 确保状态显示为禁用
        return;
    }

    const context = getContext(); // 获取当前 SillyTavern 上下文
    let sourceType: 'character' | 'group' | null = null;
    let sourceId: number | string | null = null;
    let sourceName: string = '';
    let chatName: string = '';

    // --- 确定备份来源：角色或群组 ---
    if (context.selected_group) { // 优先判断群组
        sourceType = 'group';
        sourceId = context.selected_group;
        // 从全局 groups 数组查找群组信息
        const group = context.groups?.find(g => g.id === sourceId);
        if (!group) {
            console.warn(`${extensionName}: Active group ${sourceId} not found.`);
            return; // 无法获取群组信息，中止备份
        }
        sourceName = group.name;
        chatName = group.chat_id; // 群组当前的聊天 ID
    } else if (context.this_chid !== undefined && context.this_chid !== null) { // 判断角色
        sourceType = 'character';
        sourceId = context.this_chid;
        // 从全局 characters 数组查找角色信息
        const character = context.characters?.[sourceId];
        if (!character) {
             console.warn(`${extensionName}: Active character ${sourceId} not found.`);
             return; // 无法获取角色信息，中止备份
        }
        sourceName = character.name;
        chatName = character.chat; // 角色当前的聊天文件名
    } else {
        // 既没有选择角色也没有选择群组
        console.log(`${extensionName}: No active character or group selected, skipping backup.`);
        updateBackupStatus(t('无活动聊天'));
        return;
    }

    // --- 深拷贝聊天数据 ---
    let currentChat;
    let currentMetadata;
    try {
        // 优先使用 structuredClone 进行高效深拷贝
        currentChat = structuredClone(chat);
        currentMetadata = structuredClone(chat_metadata);
    } catch (e) {
        // 如果 structuredClone 失败 (例如环境不支持或特殊数据类型)
        console.warn(`${extensionName}: structuredClone failed, falling back to JSON method. Error: ${e}`);
        try {
            // 使用 JSON 序列化/反序列化作为备选方案
            currentChat = JSON.parse(JSON.stringify(chat));
            currentMetadata = JSON.parse(JSON.stringify(chat_metadata));
        } catch (jsonError) {
            // 如果 JSON 方法也失败，则无法备份
            console.error(`${extensionName}: Failed to deep copy chat data using JSON method. Backup aborted.`, jsonError);
            toastr.error(t('无法复制聊天数据，备份中止。'));
            updateBackupStatus(t('备份失败 (复制错误)!'));
            return;
        }
    }

    // 如果当前聊天为空，则不进行备份
    if (!currentChat || currentChat.length === 0) {
        console.log(`${extensionName}: Chat is empty, skipping backup for ${sourceType} ${sourceId}.`);
        updateBackupStatus(t('聊天为空，跳过'));
        return;
    }

    // --- 构建备份对象 ---
    const lastMessageIndex = currentChat.length - 1;
    const lastMessage = currentChat[lastMessageIndex];
    // 获取最后一条消息预览 (最多100字符)
    const lastMessagePreview = lastMessage?.mes?.substring(0, 100) || '';

    const newBackup = {
        timestamp: Date.now(), // 记录备份时间戳
        sourceType: sourceType, // 来源类型: 'character' 或 'group'
        sourceId: sourceId,     // 来源 ID: 角色索引或群组 ID
        sourceName: sourceName, // 来源名称: 角色名或群组名
        chatName: chatName,     // 原始聊天名称/ID
        lastMessageId: lastMessageIndex, // 最后消息索引
        lastMessagePreview: lastMessagePreview, // 最后消息预览
        chat: currentChat,     // 深拷贝的聊天消息数组
        metadata: currentMetadata, // 深拷贝的聊天元数据
    };

    console.log(`${extensionName}: Preparing backup for ${sourceType}: ${sourceName} (${chatName})`);
    updateBackupStatus(t('准备备份...'));

    // --- 更新 localForage 中的全局备份列表 ---
    try {
        // 1. 获取当前的全局备份列表
        let backups = await localforage.getItem(STORAGE_KEY) || [];
        // 确保获取到的是数组格式
        if (!Array.isArray(backups)) {
            console.warn(`${extensionName}: Invalid data found for ${STORAGE_KEY}, resetting backup list.`);
            backups = [];
        }

        // 2. 将新的备份添加到列表开头 (最新)
        backups.unshift(newBackup);

        // 3. 截断列表，只保留最新的 MAX_BACKUPS 个备份
        if (backups.length > MAX_BACKUPS) {
            backups = backups.slice(0, MAX_BACKUPS);
        }

        // 4. 将更新后的全局列表写回 localForage
        await localforage.setItem(STORAGE_KEY, backups);
        console.log(`${extensionName}: Backup successful. Total global backups: ${backups.length}`);
        // 更新状态显示为最新备份时间
        updateBackupStatus(`${t('上次备份:')} ${new Date(newBackup.timestamp).toLocaleString()}`);

        // 如果设置面板当前可见，刷新备份列表显示
        if ($('#global-backup-settings').length) {
             displayBackups();
        }

    } catch (error) {
        console.error(`${extensionName}: Error performing backup:`, error);
        toastr.error(`${t('备份聊天失败')}: ${error.message}`, `${extensionName}`);
        updateBackupStatus(t('备份失败!'));

        // 特别处理存储空间不足的错误
        if (error && error.name === 'QuotaExceededError') {
            settings.isEnabled = false; // 自动禁用插件
            $('#global-backup-enabled').prop('checked', false); // 更新 UI
            saveSettingsDebounced(); // 保存禁用状态
            // 弹窗提示用户
            callGenericPopup(t('浏览器存储空间已满，聊天备份插件已被禁用。请清理浏览器存储或手动删除旧备份。'), POPUP_TYPE.TEXT);
            updateBackupStatus(); // 更新状态为禁用
        }
    }
}

// ==========================================================
// 5. 防抖处理与事件触发
// ==========================================================
// 创建防抖版本的备份函数
const debouncedBackup = debounce(performBackup, BACKUP_DEBOUNCE_TIME);

/**
 * 触发备份操作（调用防抖版本）
 */
function triggerBackup() {
    // 仅在插件启用时触发
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
    if (!container.length) return; // 如果容器不存在则退出

    container.html(`<p>${t('正在加载备份...')}</p>`); // 显示加载状态

    try {
        // 获取全局备份列表
        const backups = await localforage.getItem(STORAGE_KEY) || [];
        // 检查是否为数组
        if (!Array.isArray(backups)) {
             console.warn(`${extensionName}: Invalid backup data format found.`);
             container.html(`<p>${t('加载备份失败 (数据格式错误)。')}</p>`);
             return;
        }

        // 如果没有备份记录
        if (backups.length === 0) {
            container.html(`<p>${t('暂无备份记录。')}</p>`);
            return;
        }

        // 构建备份列表的 HTML
        let backupHtml = '';
        backups.forEach((backup, index) => {
            // 对每个备份对象进行基本结构验证，防止渲染出错
            if (!backup || typeof backup !== 'object' || !backup.timestamp || !backup.sourceType || backup.sourceId === undefined || !backup.sourceName) {
                console.warn(`${extensionName}: Skipping invalid backup item at index ${index}.`, backup);
                return; // 跳过无效的备份项
            }

            const dateStr = new Date(backup.timestamp).toLocaleString();
            const typeStr = backup.sourceType === 'character' ? t('角色') : t('群组');
            // 处理预览文本，进行 HTML 转义防止 XSS
            const preview = backup.lastMessagePreview ? escapeHtml(backup.lastMessagePreview) + '...' : `(${t('无预览')})`;

            // 为每个备份项生成 HTML 结构
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

        // 将生成的 HTML 填充到容器中，如果没有有效的备份项则显示提示
        container.html(backupHtml || `<p>${t('暂无有效备份记录。')}</p>`);

    } catch (error) {
        // 处理加载过程中的错误
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
    if (!unsafe) return '';
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

     // --- 1. 加载并验证备份数据 ---
     try {
        // 获取全局备份列表
        backups = await localforage.getItem(STORAGE_KEY) || [];
        // 检查索引有效性及列表格式
        if (!Array.isArray(backups) || backupIndex < 0 || backupIndex >= backups.length) {
            toastr.error(t('无效的备份索引或无法加载备份列表。'));
            console.error(`${extensionName}: Invalid backup index or failed to load backups.`);
            return;
        }
        // 获取指定的备份对象
        backupData = backups[backupIndex];

        // 再次验证备份对象结构是否完整
        if (!backupData || typeof backupData !== 'object' || !backupData.timestamp || !backupData.sourceType || backupData.sourceId === undefined || !backupData.chat || !backupData.metadata) {
             toastr.error(t('备份数据无效或不完整，无法恢复。'));
             console.error(`${extensionName}: Invalid or incomplete backup data at index ${backupIndex}.`, backupData);
             return;
        }

     } catch (error) {
         // 处理加载备份数据时的错误
         toastr.error(t('加载备份数据失败。'));
         console.error(`${extensionName}: Error loading backup data for restore:`, error);
         return;
     }

     // --- 2. 用户确认 ---
     // 构建确认消息，包含来源信息
     const confirmMessage = `
         <h4>${t('确认恢复')}</h4>
         <p>${t('这将切换到 <b>{sourceName}</b> ({sourceType}) 并创建一个 <b>新聊天</b> 来恢复备份内容。此操作不可撤销。').replace('{sourceName}', escapeHtml(backupData.sourceName)).replace('{sourceType}', backupData.sourceType === 'character' ? t('角色') : t('群组'))}</p>
         <p>${t('备份时间:')} ${new Date(backupData.timestamp).toLocaleString()}</p>
     `;

     try {
        // 显示确认弹窗，如果用户取消会抛出错误
        await callGenericPopup(confirmMessage, POPUP_TYPE.CONFIRM);
     } catch {
        // 用户点击了取消
        console.log(`${extensionName}: Restore cancelled by user.`);
        toastr.info(t('恢复操作已取消。'));
        return;
     }

     // --- 3. 执行恢复流程 ---
     console.log(`${extensionName}: User confirmed restore. Proceeding...`);
     updateBackupStatus(t('正在恢复...')); // 更新状态显示

     try {
         // 从备份数据中解构所需信息
         const { sourceType, sourceId, chat: backupChatArray, metadata: backupMetadata } = backupData;

         // --- 步骤 a: 切换上下文 ---
         console.log(`${extensionName}: Switching context to ${sourceType} ${sourceId}...`);
         if (sourceType === 'character') {
             // 切换到目标角色
             await selectCharacterById(sourceId);
         } else if (sourceType === 'group') {
             // 确保 openGroupById 函数可用并调用
             if (typeof openGroupById === 'function') {
                await openGroupById(sourceId); // 切换到目标群组
             } else {
                 // 如果函数不可用，抛出错误
                 throw new Error('openGroupById function is not available.');
             }
         } else {
             // 未知来源类型，抛出错误
             throw new Error(`Unknown sourceType: ${sourceType}`);
         }
         // 短暂等待，让状态切换生效 (可能需要调整时间)
         await new Promise(res => setTimeout(res, 200));
         console.log(`${extensionName}: Context switched.`);

         // --- 步骤 b: 创建新聊天 ---
         console.log(`${extensionName}: Creating new chat...`);
         if (sourceType === 'character') {
             // 为当前角色创建新聊天
             await doNewChat();
         } else if (sourceType === 'group') {
             // 确保 createNewGroupChat 函数可用并调用
             if (typeof createNewGroupChat === 'function') {
                await createNewGroupChat(sourceId); // 为当前群组创建新聊天
             } else {
                 throw new Error('createNewGroupChat function is not available.');
             }
         }
         // 短暂等待，让新聊天创建和加载完成 (可能需要调整时间)
         await new Promise(res => setTimeout(res, 200));
         console.log(`${extensionName}: New chat created.`);

         // --- 步骤 c: 注入备份数据 ---
         console.log(`${extensionName}: Injecting backup data...`);
         // **直接修改全局 chat 数组**: 清空并填充备份内容
         chat.splice(0, chat.length, ...backupChatArray);
         // **直接修改全局 chat_metadata 对象**: 清空并填充备份内容
         Object.keys(chat_metadata).forEach(key => delete chat_metadata[key]); // 清空现有元数据
         Object.assign(chat_metadata, backupMetadata); // 合并备份的元数据
         console.log(`${extensionName}: Data injected. Chat length: ${chat.length}`);

         // --- 步骤 d: 重新渲染聊天界面 ---
         console.log(`${extensionName}: Rendering messages...`);
         // 使用 printMessages(true) 进行完全刷新，它会处理 showMoreMessages 逻辑
         await printMessages(true);
         console.log(`${extensionName}: Messages rendered.`);

         // --- 步骤 e: 保存新的聊天状态 ---
         console.log(`${extensionName}: Saving restored chat state...`);
         // 保存这个新创建并填充了内容的聊天
         await saveChatConditional();
         console.log(`${extensionName}: Restored chat saved.`);

         // --- 恢复成功反馈 ---
         toastr.success(t('聊天已成功从备份恢复到新会话中！'));
         updateBackupStatus(t('恢复成功'));

     } catch (error) {
         // --- 处理恢复过程中的错误 ---
         console.error(`${extensionName}: Error during restore process:`, error);
         toastr.error(`${t('恢复过程中发生错误:')} ${error.message}`);
         updateBackupStatus(t('恢复失败!'));
         // 考虑在严重失败时重新加载当前聊天状态以恢复界面
         // await reloadCurrentChat?.(); // 可选的安全措施
     }
}

// ==========================================================
// 8. 清除备份功能
// ==========================================================
/**
 * 清除 localForage 中的所有聊天备份
 */
async function clearAllBackups() {
    // --- 1. 用户确认 ---
    try {
        // 显示确认弹窗
        await callGenericPopup(
            `<h4>${t('确认清除')}</h4><p>${t('这将永久删除所有已保存的聊天备份。此操作无法撤销。')}</p>`,
            POPUP_TYPE.CONFIRM
        );
    } catch {
        // 用户取消
        console.log(`${extensionName}: Clear backups cancelled by user.`);
        toastr.info(t('清除操作已取消。'));
        return;
    }

    // --- 2. 执行清除 ---
    try {
        console.log(`${extensionName}: Clearing all backups...`);
        // 从 localForage 中移除存储键
        await localforage.removeItem(STORAGE_KEY);
        console.log(`${extensionName}: All backups cleared.`);
        toastr.success(t('所有聊天备份已清除。'));
        // 刷新备份列表显示 (应该变为空)
        displayBackups();
        // 更新状态显示
        updateBackupStatus();

    } catch (error) {
        // 处理清除过程中的错误
        console.error(`${extensionName}: Error clearing backups:`, error);
        toastr.error(t('清除备份时出错。'));
    }
}


// ==========================================================
// 9. 插件初始化 (jQuery(async () => { ... }))
// ==========================================================
// 使用 jQuery(async () => { ... }) 确保在 DOM 加载完成后执行
jQuery(async () => {
    console.log(`Loading extension: ${extensionName}`);

    // --- 1. 加载并注入 HTML 模板 ---
    try {
        // 异步加载 backup_display.html 的内容
        const settingsHtml = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'backup_display');
        // 将加载的 HTML 追加到 SillyTavern 的扩展设置区域
        // 注意: '#extensions_settings' 是常见的目标 ID，但可能随 ST 版本变化
        $('#extensions_settings').append(settingsHtml);
    } catch (error) {
        // 处理模板加载或注入失败的情况
        console.error(`${extensionName}: Failed to load or inject HTML template:`, error);
        // 可以在设置区域显示错误消息
        $('#extensions_settings').append(`<div style="color: red;">${t('插件 {extensionName} UI 加载失败。').replace('{extensionName}', extensionName)}</div>`);
        return; // 如果 UI 加载失败，停止后续初始化
    }

    // --- 2. 加载插件设置 ---
    await loadSettings(); // 加载设置并更新 UI

    // --- 3. 绑定设置界面元素的事件监听器 ---
    // 启用/禁用复选框的 change 事件
    $('#global-backup-enabled').on('change', function () {
        // 更新设置对象中的值
        extension_settings[extensionName].isEnabled = $(this).prop('checked');
        // 调用防抖保存函数来保存所有设置
        saveSettingsDebounced();
        // 更新状态显示文本
        updateBackupStatus();
        // 如果是刚刚启用，可以考虑立即触发一次备份检查 (防抖会处理频率)
        if (extension_settings[extensionName].isEnabled) {
            triggerBackup();
        }
    });

    // 刷新按钮的 click 事件
    $('#global-backup-refresh').on('click', displayBackups);
    // 清除按钮的 click 事件
    $('#global-backup-clear').on('click', clearAllBackups);

    // **关键: 使用事件委托**为动态生成的恢复按钮绑定 click 事件
    // 监听父容器 '#global-backup-list-container' 上的点击事件
    // 但只处理来源是 'button.restore-backup' 的点击
    $('#global-backup-list-container').on('click', 'button.restore-backup', function () {
        // 从被点击按钮的 data-backup-index 属性获取索引
        const backupIndex = parseInt($(this).data('backup-index'), 10);
        // 检查索引是否有效
        if (!isNaN(backupIndex)) {
            // 调用恢复函数
            restoreBackup(backupIndex);
        } else {
            // 如果索引无效，给出错误提示
            console.error(`${extensionName}: Invalid backup index on button.`);
            toastr.error(t('无法识别的备份项目。'));
        }
    });

    // --- 4. 页面加载时显示初始备份列表 ---
    displayBackups();

    // --- 5. 监听 SillyTavern 核心事件以触发自动备份 ---
    // 定义需要触发备份的事件列表
    const eventsToTriggerBackup = [
        event_types.MESSAGE_SENT, // 用户发送消息后
        event_types.GENERATION_ENDED, // AI 回复生成结束后
        event_types.MESSAGE_SWIPED, // 消息滑动切换后
        event_types.MESSAGE_EDITED, // 消息编辑后
        event_types.MESSAGE_DELETED, // 消息删除后
    ];
    // 为列表中的每个事件类型注册监听器，调用 triggerBackup (防抖版本)
    eventsToTriggerBackup.forEach(eventType => {
        eventSource.on(eventType, triggerBackup);
    });

    // (可选) 监听聊天切换事件，可以取消待处理的备份并更新状态
     eventSource.on(event_types.CHAT_CHANGED, () => {
         // 如果 debouncedBackup 对象存在 cancel 方法 (来自 lodash/underscore debounce)
         if (typeof debouncedBackup.cancel === 'function') {
             debouncedBackup.cancel(); // 取消可能正在等待执行的备份
             console.debug(`${extensionName}: Chat changed, cancelled pending backup.`);
         }
         // 聊天切换后也更新状态显示
         updateBackupStatus();
     });


    // --- 6. 初始化完成日志 ---
    console.log(`Plugin ${extensionName} loaded and initialized.`);
}); // jQuery Ready End
