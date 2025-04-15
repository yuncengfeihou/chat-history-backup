// 监听主线程消息
self.onmessage = async function(event) {
    const { chat, metadata, storageKey, maxBackups } = event.data;
    
    try {
        // 导入localforage (在Web Worker中)
        importScripts('../../../lib/localforage.min.js');
        
        // 1. 获取该聊天的现有备份列表
        let backups = await localforage.getItem(storageKey) || [];
        
        // 确保获取到的是数组
        if (!Array.isArray(backups)) {
            backups = [];
        }
        
        // 2. 获取当前角色/群组和聊天信息
        const characterName = metadata.character_name || '未知角色';
        const groupName = metadata.group_name || null;
        const chatTitle = metadata.chat_title || '未命名聊天';
        const lastMessageId = chat.length > 0 ? chat[chat.length - 1].id || 0 : 0;
        
        // 3. 创建消息预览
        let lastMessagePreview = '';
        if (chat.length > 0) {
            const lastMessage = chat[chat.length - 1];
            lastMessagePreview = lastMessage.mes || '';
            // 截取前100个字符作为预览
            if (lastMessagePreview.length > 100) {
                lastMessagePreview = lastMessagePreview.substring(0, 100) + '...';
            }
        }
        
        // 4. 创建新的备份条目
        const newBackup = {
            timestamp: Date.now(),
            chat: structuredClone(chat),
            metadata: structuredClone(metadata),
            // 额外信息用于UI显示
            info: {
                entityName: groupName || characterName,
                chatTitle: chatTitle,
                lastMessageId: lastMessageId,
                messageCount: chat.length,
                lastMessagePreview: lastMessagePreview,
                isGroup: !!groupName
            }
        };
        
        // 5. 将新备份添加到列表的开头 (最新的在前)
        backups.unshift(newBackup);
        
        // 6. 保留最多maxBackups个备份
        if (backups.length > maxBackups) {
            backups = backups.slice(0, maxBackups);
        }
        
        // 7. 将更新后的备份列表写回localStorage
        await localforage.setItem(storageKey, backups);
        
        // 8. 向主线程发送成功消息
        self.postMessage({
            success: true,
            backupInfo: {
                timestamp: newBackup.timestamp,
                entityName: newBackup.info.entityName,
                chatTitle: newBackup.info.chatTitle,
                backupCount: backups.length
            }
        });
    } catch (error) {
        // 向主线程返回错误
        self.postMessage({
            success: false,
            error: error.message || 'Unknown error in backup worker'
        });
    }
};
