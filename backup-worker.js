const STORAGE_KEY_PREFIX = "chat_backup_";

self.addEventListener('message', async function(event) {
    const { type, data } = event.data;
    
    if (type === 'backup') {
        const { chat, metadata, chatId, maxBackups } = data;
        const storageKey = `${STORAGE_KEY_PREFIX}${chatId}`;
        
        try {
            // Get existing backups
            let backups = await localforage.getItem(storageKey) || [];
            
            // Add new backup
            backups.unshift({
                timestamp: Date.now(),
                chat,
                metadata
            });
            
            // Trim to max backups
            if (backups.length > maxBackups) {
                backups = backups.slice(0, maxBackups);
            }
            
            // Save
            await localforage.setItem(storageKey, backups);
            self.postMessage({ type: 'backupComplete' });
        } catch (error) {
            console.error('Backup failed:', error);
        }
    } else if (type === 'list') {
        const keys = await localforage.keys();
        const backupKeys = keys.filter(key => key.startsWith(STORAGE_KEY_PREFIX));
        const backups = [];
        
        for (const key of backupKeys) {
            const chatBackups = await localforage.getItem(key);
            backups.push(...chatBackups);
        }
        
        self.postMessage({ type: 'backupList', data: backups });
    }
});
