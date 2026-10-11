import { groupApi, messageApi } from './api';
import type { ChatMessage } from '../types';

/**
 * Chat backup as a plain-text file.
 *
 * Lives here (not inside ChatWindow) because 导出 is reachable from two places:
 * the old header button and the 聊天信息 page. The page has no message list of
 * its own, so the export pulls the thread from the server instead.
 */

export interface ExportLine {
  who: string;
  when: string;
  text: string;
}

/** One `[时间] 谁: 内容` line per message under a small header. */
export function buildExportText(header: string, lines: ExportLine[]): string {
  const body = lines.map((line) => `[${line.when}] ${line.who}: ${line.text}`).join('\n');
  return `${header}\n\n${body}\n`;
}

export function downloadText(fileName: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

const toLine = (message: ChatMessage, myId: number, peerLabel: string): ExportLine => ({
  who:
    message.fromUserId === myId
      ? '我'
      : message.fromUser?.nickname ?? (message.fromUserId ? `用户 #${message.fromUserId}` : peerLabel),
  when: new Date(message.createdAt).toLocaleString(),
  text: message.recalled ? '[消息已撤回]' : message.content || '',
});

const PAGE = 200;

/** Walks history backwards from the newest message until a short page. */
async function fetchThread(kind: 'direct' | 'group', id: number): Promise<ChatMessage[]> {
  const collected: ChatMessage[] = [];
  let beforeId = 0;
  for (let page = 0; page < 50; page += 1) {
    const res =
      kind === 'group'
        ? await groupApi.history(id, beforeId, PAGE)
        : await messageApi.history(id, beforeId, PAGE);
    const batch = res.messages ?? [];
    if (batch.length === 0) break;
    collected.unshift(...batch);
    if (batch.length < PAGE) break;
    beforeId = Math.min(...batch.map((message) => Number(message.id) || 0));
    if (!beforeId) break;
  }
  return collected;
}

/**
 * Fetches the whole thread and downloads it. `title` is the conversation's
 * display name (group name or the peer's name).
 */
export async function exportConversation(
  kind: 'direct' | 'group',
  id: number,
  title: string,
  myId: number
): Promise<void> {
  const messages = await fetchThread(kind, id);
  const header = kind === 'group' ? `群聊记录：${title}` : `与 ${title} 的聊天记录`;
  const text = buildExportText(
    header,
    messages.map((message) => toLine(message, myId, title))
  );
  downloadText(`${kind === 'group' ? 'group' : 'chat'}-${id}.txt`, text);
}
