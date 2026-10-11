import { useEffect, useState } from 'react';
import { attachmentRawUrl, groupApi } from '../lib/api';
import { session } from '../lib/session';
import { formatBytes, formatDateTime } from '../lib/format';
import { SidePage } from './SidePage';

interface GroupFile {
  messageId: number;
  attachmentId: number;
  name: string;
  size: number;
  mime: string;
  fromNickname: string | null;
  createdAt: string;
}

interface GroupFilesPageProps {
  groupId: number;
  onBack: () => void;
}

/** 群文件 — the shared-files sub-page of 群聊详情. */
export function GroupFilesPage({ groupId, onBack }: GroupFilesPageProps) {
  const [files, setFiles] = useState<GroupFile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    groupApi
      .files(groupId)
      .then((data) => {
        if (!cancelled) setFiles(data.files);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  return (
    <SidePage title="群文件" onBack={onBack} testId="group-files-page">
      {loading && <div className="panel-empty">加载中…</div>}
      {!loading && files.length === 0 && <div className="panel-empty">群里还没有共享文件</div>}
      {!loading && files.length > 0 && (
        <ul className="settings-list" data-testid="group-files">
          {files.map((file) => (
            <li key={file.messageId}>
              <span className="settings-session">
                <span>{file.name}</span>
                <span className="settings-row-hint">
                  {file.fromNickname ?? '成员'} · {formatBytes(file.size)} · {formatDateTime(file.createdAt)}
                </span>
              </span>
              <a
                className="btn btn-sm btn-ghost"
                href={attachmentRawUrl(file.attachmentId, session.getAccessToken())}
                target="_blank"
                rel="noopener noreferrer"
              >
                下载
              </a>
            </li>
          ))}
        </ul>
      )}
    </SidePage>
  );
}
