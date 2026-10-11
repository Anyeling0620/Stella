import { useCallback, useMemo, useState } from 'react';
import { messageApi } from '../lib/api';
import { formatClock, formatDayLabel } from '../lib/format';
import { SidePage } from './SidePage';
import type { ChatMessage } from '../types';

interface ChatSearchPageProps {
  peerKind: 'direct' | 'group';
  peerId: number;
  title: string;
  frozen: boolean;
  onBack: () => void;
  /** Return to the conversation and scroll to this message. */
  onJump: (messageId: number) => void;
}

/** UTC bounds of the local calendar day `YYYY-MM-DD` (the pool is UTC end-to-end). */
const dayRange = (value: string): { from: string; to: string } | null => {
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { from: start.toISOString(), to: end.toISOString() };
};

/** One-line preview — media has empty `content`, so label it. */
function preview(message: ChatMessage): string {
  if (message.recalled) return '消息已撤回';
  switch (message.type) {
    case 'image':
      return '[图片]';
    case 'file':
      return `[文件] ${message.attachment?.name ?? ''}`.trim();
    case 'voice':
      return '[语音]';
    default:
      return message.content;
  }
}

/**
 * 查找聊天记录 — a dedicated page (WeChat-style) instead of an inline panel.
 *
 * Keyword search, a single-day filter (WeChat's 按日期), or both. Picking a day
 * browses it immediately; results are grouped by day and hand the message id
 * back so the conversation can scroll to it.
 */
export function ChatSearchPage({ peerKind, peerId, title, frozen, onBack, onJump }: ChatSearchPageProps) {
  const [keyword, setKeyword] = useState('');
  const [date, setDate] = useState('');
  const [results, setResults] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const runSearch = useCallback(
    async (override?: { q?: string; date?: string }) => {
      const q = (override?.q ?? keyword).trim();
      const day = override?.date ?? date;
      const range = day ? dayRange(day) : null;
      if (!q && !range) {
        setResults([]);
        setSearched(false);
        return;
      }
      setLoading(true);
      try {
        const data = await messageApi.search({
          ...(peerKind === 'group' ? { groupId: peerId } : { friendId: peerId }),
          ...(q ? { q } : {}),
          ...(range ?? {}),
        });
        setResults(data.messages);
      } catch {
        setResults([]);
      } finally {
        setSearched(true);
        setLoading(false);
      }
    },
    [keyword, date, peerKind, peerId]
  );

  const grouped = useMemo(() => {
    const map = new Map<string, ChatMessage[]>();
    for (const message of results) {
      const label = formatDayLabel(message.createdAt);
      const list = map.get(label);
      if (list) list.push(message);
      else map.set(label, [message]);
    }
    return [...map.entries()];
  }, [results]);

  return (
    <SidePage title="查找聊天记录" onBack={onBack} testId="chat-search-page">
      <div className="chat-search">
        <div className="chat-search-bar">
          <input
            autoFocus
            value={keyword}
            data-testid="chat-search-input"
            placeholder={`搜索「${title}」的聊天记录`}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void runSearch();
              }
            }}
          />
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void runSearch()}>
            搜索
          </button>
        </div>
        <div className="chat-search-bar">
          <span className="chat-search-date-label">按日期</span>
          <input
            type="date"
            className="chat-search-date"
            data-testid="chat-search-date"
            value={date}
            disabled={frozen}
            onChange={(event) => {
              setDate(event.target.value);
              void runSearch({ date: event.target.value });
            }}
          />
          {date && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setDate('');
                void runSearch({ date: '' });
              }}
            >
              清除
            </button>
          )}
        </div>
      </div>

      {loading && <div className="panel-empty">搜索中…</div>}
      {!loading && searched && results.length === 0 && <div className="panel-empty">没有找到相关消息</div>}

      {!loading &&
        grouped.map(([label, list]) => (
          <div key={label}>
            <div className="cell-title">{label}</div>
            <ul className="chat-search-results" data-testid="chat-search-results">
              {list.map((message) => (
                <li key={message.id}>
                  <button type="button" data-testid="chat-search-result" onClick={() => onJump(message.id)}>
                    {peerKind === 'group' && (
                      <span className="chat-search-who">{message.fromUser?.nickname ?? '成员'}</span>
                    )}
                    <span className="chat-search-text">{preview(message)}</span>
                    <span className="chat-search-time">{formatClock(message.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </SidePage>
  );
}
