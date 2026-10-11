import { memo, useEffect, useRef, useState } from 'react';
import { groupApi } from '../lib/api';
import { ApiError, isCancelError } from '../lib/axiosClient';
import { convKey } from '../lib/conversation';
import { useAppActions } from '../context/AppContext';
import { Avatar } from './Avatar';
import type { Group } from '../types';
import { Icon } from './Icon';

interface GroupsPanelProps {
  groups: Group[];
  unread: Record<string, number>;
  mentioned: Record<string, boolean>;
  onOpenGroup: (groupId: number) => void;
  onCreateGroup: () => void;
  frozen: boolean;
}

/**
 * Dedicated "群聊" tab: my groups, plus QQ-style group discovery.
 *
 * Search matches an exact 群号 or a name substring and excludes groups the user
 * already belongs to. Applying to join notifies the group owner (who approves
 * from 群信息), so the button settles into "已申请" until a decision arrives.
 */
export const GroupsPanel = memo(function GroupsPanel({
  groups,
  unread,
  mentioned,
  onOpenGroup,
  onCreateGroup,
  frozen,
}: GroupsPanelProps) {
  const { pushToast } = useAppActions();
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<Group[]>([]);
  const [searching, setSearching] = useState(false);
  const [requested, setRequested] = useState<Set<number>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  // Debounced search with explicit race cancellation of the previous query.
  useEffect(() => {
    const term = keyword.trim();
    if (term.length === 0) {
      abortRef.current?.abort();
      setResults([]);
      setSearching(false);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setSearching(true);
      groupApi
        .search(term, controller.signal)
        .then((data) => setResults(data.groups))
        .catch((error) => {
          if (!isCancelError(error)) {
            pushToast({ kind: 'error', title: '搜索群聊失败', body: error instanceof ApiError ? error.message : '' });
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 300);

    return () => {
      window.clearTimeout(timer);
      // Cancel the in-flight query too, so leaving the panel (or typing again)
      // never leaves an orphaned request resolving into a dead component.
      abortRef.current?.abort();
    };
  }, [keyword, pushToast]);

  const apply = async (group: Group) => {
    try {
      await groupApi.requestJoin(group.id);
      setRequested((previous) => new Set(previous).add(group.id));
      pushToast({ kind: 'success', title: '已发送加群申请', body: `等待群主「${group.name}」同意` });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: '申请失败',
        body: error instanceof ApiError ? error.message : '请稍后重试',
      });
    }
  };

  return (
    <div className="friends-panel">
      <div className="search-box">
        <input
          data-testid="group-search-input"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索群号 / 群名称"
          disabled={frozen}
        />
        {searching && <span className="search-spinner">…</span>}
      </div>

      <button
        type="button"
        className="btn btn-sm btn-primary btn-block"
        data-testid="groups-create"
        disabled={frozen}
        onClick={onCreateGroup}
      >
        <Icon name="plus" size={16} /> 发起群聊
      </button>

      {keyword.trim().length > 0 && (
        <div className="panel-section">
          <div className="panel-title">搜索结果</div>
          {results.length === 0 && !searching && <div className="panel-empty">没有找到匹配的群聊</div>}
          {results.map((group) => {
            const pending = requested.has(group.id) || group.requestStatus === 'pending';
            return (
              <div key={group.id} className="list-row" data-testid="group-search-result" data-group-id={group.id}>
                <Avatar name={group.name} avatar={group.avatar} size={40} tone="muted" />
                <div className="list-row-text">
                  <div className="list-row-title">{group.name}</div>
                  <div className="list-row-sub">
                    群号 {group.groupNo ?? '—'} · {group.memberCount ?? 0} 人
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  data-testid="group-join-apply"
                  disabled={frozen || pending}
                  onClick={() => void apply(group)}
                >
                  {pending ? '已申请' : group.requestStatus === 'rejected' ? '重新申请' : '申请加入'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="panel-section">
        <div className="panel-title">我的群聊（{groups.length}）</div>
        {groups.length === 0 && <div className="panel-empty">还没有加入任何群聊</div>}
        {groups.map((group) => {
          const key = convKey.group(group.id);
          return (
            <button
              key={key}
              type="button"
              className="conversation-item conversation-group"
              data-testid="group-item"
              data-group-id={group.id}
              onClick={() => onOpenGroup(group.id)}
              disabled={frozen}
            >
              <Avatar name={group.name} avatar={group.avatar} size={40} />
              <span className="conversation-main">
                <span className="conversation-name">{group.name}</span>
                <span className="conversation-sub">
                  群号 {group.groupNo ?? '—'} · {group.memberCount ?? 0} 人
                </span>
              </span>
              {mentioned[key] ? (
                <span className="badge badge-mention">@</span>
              ) : (unread[key] ?? 0) > 0 ? (
                <span className="badge badge-unread">{unread[key]}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
});
