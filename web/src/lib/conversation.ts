/**
 * Conversation keys.
 *
 * 1:1 and group conversations share one list in the UI, so the active
 * conversation is identified by a single string key instead of a bare friend id:
 *
 *   `d:123`  — direct conversation with user 123
 *   `g:45`   — group conversation with group 45
 *
 * The key is opaque to the UI; use these helpers rather than string surgery.
 */
export type ConversationRef =
  | { kind: 'direct'; id: number }
  | { kind: 'group'; id: number };

export const convKey = {
  direct: (userId: number) => `d:${userId}`,
  group: (groupId: number) => `g:${groupId}`,
};

export function parseConversationKey(key: string | null | undefined): ConversationRef | null {
  if (!key || key.length < 3) return null;
  const id = Number(key.slice(2));
  if (!Number.isInteger(id) || id <= 0) return null;
  if (key.startsWith('d:')) return { kind: 'direct', id };
  if (key.startsWith('g:')) return { kind: 'group', id };
  return null;
}
