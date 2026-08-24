'use strict';

const MESSAGE_CLASS = Object.freeze({ transient: 'transient', permanent: 'permanent' });

function normalizeMessageIds(ids) {
  return [...new Set((ids || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

async function deleteMessagesBestEffort(telegram, chatId, ids, logger = console) {
  const messageIds = normalizeMessageIds(ids);
  if (!messageIds.length) return { attempted: 0, deleted: 0 };
  let deleted = 0;
  for (let offset = 0; offset < messageIds.length; offset += 100) {
    const batch = messageIds.slice(offset, offset + 100);
    try {
      await telegram.callApi('deleteMessages', { chat_id: chatId, message_ids: batch });
      deleted += batch.length;
      continue;
    } catch (_) {
      // Older Bot API servers and permission-limited chats fall back safely.
    }
    for (const messageId of batch) {
      try {
        await telegram.deleteMessage(chatId, messageId);
        deleted += 1;
      } catch (error) {
        const message = String(error?.message || '').toLowerCase();
        if (!message.includes('message to delete not found') && !message.includes("message can't be deleted")) {
          logger.warn?.('chat_cleanup_failed', { chatId, messageId, message: String(error?.message || '').slice(0, 120) });
        }
      }
    }
  }
  return { attempted: messageIds.length, deleted };
}

module.exports = { MESSAGE_CLASS, normalizeMessageIds, deleteMessagesBestEffort };
