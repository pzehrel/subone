import { useEffect, useState } from 'react';
import { Check, Copy, Download, Loader2 } from 'lucide-react';
import { getSourceRaw } from '../api';
import type { SourceRawRecord, SubscriptionSource } from '../types';
import { copyToClipboard } from '../utils/clipboard';
import { Modal, ModalBody } from './Modal';
import { Badge } from './ui/Badge';

interface SourceRawModalProps {
  source: SubscriptionSource | null;
  onClose: () => void;
}
const formatNames: Record<string, string> = { mihomo: 'Mihomo', singbox: 'sing-box', quantumultx: 'QuanX', uri: 'URI', base64: 'Base64' };
const time = (value?: string) => value ? new Date(value).toLocaleString() : '—';

export function SourceRawModal({ source, onClose }: SourceRawModalProps) {
  return (
    <Modal open={source !== null} title={`${source?.name || ''} 原文`} size="xl" onClose={onClose}>
      {source && <SourceRawContent key={source.id} source={source} />}
    </Modal>
  );
}

function SourceRawContent({ source }: { source: SubscriptionSource }) {
  const [raw, setRaw] = useState<SourceRawRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const sourceId = source.id;
  useEffect(() => {
    const controller = new AbortController();
    getSourceRaw(sourceId, controller.signal).then(setRaw).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '原文读取失败');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sourceId]);

  async function copy() {
    if (!raw) return;
    if (await copyToClipboard(raw.content)) {
      setCopied(true);
      setError('');
    } else setError('复制失败，请手动选择原文复制');
  }
  function download() {
    if (!raw || !source) return;
    const url = URL.createObjectURL(new Blob([raw.content], { type: raw.contentType || 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    const extension = raw.format === 'mihomo' ? 'yaml' : raw.format === 'singbox' ? 'json' : raw.format === 'quantumultx' ? 'conf' : 'txt';
    anchor.download = `${source.name.replace(/[\\/:*?"<>|]/g, '_')}-原文.${extension}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <ModalBody className="space-y-4">
        {loading && <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={16} className="animate-spin" />读取中</div>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {raw && <>
          <div className="flex items-start justify-between gap-3">
            <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-slate-500">
              <dt>原文取回</dt><dd>{time(raw.fetchedAt)}</dd>
              <dt>生效结果</dt><dd>{time(raw.lastSuccessfulUpdate)}</dd>
              <dt>格式</dt><dd>{raw.format ? formatNames[raw.format] : '未识别'}</dd>
              <dt>Content-Type</dt><dd className="break-all">{raw.contentType || '未提供'}</dd>
            </dl>
            <div className="flex shrink-0 items-center gap-1">
              <button type="button" className="p-2 rounded-lg hover:bg-slate-100" title={copied ? '已复制' : '复制原文'} aria-label={copied ? '已复制原文' : '复制原文'} onClick={copy}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
              <button type="button" className="p-2 rounded-lg hover:bg-slate-100" title="下载原文" aria-label="下载原文" onClick={download}><Download size={16} /></button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={raw.parseStatus === 'success' ? 'success' : 'danger'}>{raw.parseStatus === 'success' ? '解析成功' : '解析失败，沿用上次生效结果'}</Badge>
            {raw.error && <p className="text-xs text-red-600">{raw.error}</p>}
          </div>
          <pre tabIndex={0} className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-all rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-700">{raw.content}</pre>
        </>}
    </ModalBody>
  );
}
