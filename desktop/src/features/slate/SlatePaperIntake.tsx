import { useEffect, useMemo, useRef, useState } from 'react';
import type { SlateCandidateState } from '../../api/desktop';
import { PaperSourceMatch } from './PaperSourceMatch';
import {
  PaperIntakeClient,
  validatePaperInput,
  type PaperModel,
  type PaperRow,
  type PaperVlmCandidate,
} from '../../api/paperIntake';
import './slate-paper-intake.css';
import { SlatePdfDraft } from './SlatePdfDraft';
import { SlatePaperOriginal } from './SlatePaperOriginal';

type ReviewCandidate = PaperVlmCandidate & { checked: boolean };

interface Props {
  baseUrl: string;
  projectId: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  onSelect?: (source: { row: PaperRow; revision: number } | null) => void;
  onApplyDraftCandidates?: (candidates: PaperVlmCandidate[]) => void;
  /** Persisted proposals from the project-level durable recognition task. */
  recognition?: SlateCandidateState | null;
  recognitionBusy?: boolean;
  onStartRecognition?: () => void;
}

const STATUS_LABELS: Record<PaperVlmCandidate['status'], string> = {
  usable: '可用',
  partial: '部分可用',
  ng: 'NG',
  unmarked: '未标',
};

/** Imported transcription is evidence, never a saved slate or confirmed source interval. */
export function SlatePaperIntake({
  baseUrl,
  projectId,
  open: openProp,
  onOpenChange,
  hideTrigger = false,
  onSelect,
  onApplyDraftCandidates,
  recognition,
  recognitionBusy = false,
  onStartRecognition,
}: Props) {
  const client = useMemo(() => new PaperIntakeClient(baseUrl), [baseUrl]);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp === undefined ? uncontrolledOpen : openProp;
  const [model, setModel] = useState<PaperModel | null>(null);
  const [content, setContent] = useState('');
  const [format, setFormat] = useState<'json' | 'csv'>('json');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(true);
  const [focusSource, setFocusSource] = useState(0);
  const [candidates, setCandidates] = useState<ReviewCandidate[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sourceRef = useRef<HTMLSelectElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  const generation = useRef(0);
  const openLoadRef = useRef(false);
  const projectCandidatesLoaded = useRef('');

  useEffect(() => {
    if (focusSource) sourceRef.current?.focus();
  }, [focusSource]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const close = () => {
    if (openProp === undefined) setUncontrolledOpen(false);
    onOpenChange?.(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, openProp, onOpenChange]);

  async function load() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const gen = ++generation.current;
    try {
      const next = await client.request(projectId);
      if (mounted.current && gen === generation.current) setModel(next);
    } catch (e) {
      if (mounted.current) {
        setError(String(e instanceof Error ? e.message : e));
        setModel(null);
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) {
      openLoadRef.current = false;
      return;
    }
    if (!openLoadRef.current) {
      openLoadRef.current = true;
      if (!model) void load();
    }
  }, [open, model, client, projectId]);

  function renderExtractedCandidates(result: Awaited<ReturnType<PaperIntakeClient['extractPhotoCandidates']>>): void {
    if (result.candidates.length > 0) {
      const nextCandidates = result.candidates.map((candidate) => ({ ...candidate, checked: true, authority: false as const }));
      setCandidates(nextCandidates);
      const draftRows = result.candidates.map((item) => ({
        page: item.page,
        row: String(item.row),
        ...(item.episode !== null ? { episode: item.episode } : {}),
        scene: item.scene,
        shot: item.shot,
        take: item.take,
        status: item.status,
        note: item.note,
      }));
      setFormat('json');
      setContent(JSON.stringify(draftRows, null, 2));
      setEditing(true);
      setNotice('AI (' + result.provider + '/' + result.model + ') 已提取 ' + result.candidate_count + ' 条候选，请核对后填入未保存草稿。');
    } else {
      setNotice(result.warning || '未从场记文件识别到结构化场记行，请人工录入或换清晰文件重试。');
    }
  }

  async function extractPhoto(file: File) {
    if (lock.current) return;
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const maxBytes = isPdf ? 20 * 1024 * 1024 : 8 * 1024 * 1024;
    if (file.size > maxBytes) {
      setError(isPdf ? 'PDF 超过 20 MB 大小上限，请压缩后再识别。' : '图片超过 8 MB 大小上限，请压缩后再识别。');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('正在调用多模态视觉模型提取场记候选…');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
      const result = await client.extractPhotoCandidates(dataUrl, '1');
      if (!mounted.current) return;
      renderExtractedCandidates(result);
    } catch (e) {
      if (mounted.current) setError(String(e instanceof Error ? e.message : e));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
      if (photoInputRef.current) photoInputRef.current.value = '';
    }
  }

  // Durable recognition proposals become review rows only. They never
  // auto-fill drafts, and a human manually uploaded file is never re-skipped.
  useEffect(() => {
    if (!recognition || recognition.status !== 'completed' || !recognition.candidates.length) return;
    const key = `${projectId}:${recognition.revision}`;
    if (projectCandidatesLoaded.current === key || candidates.length) return;
    projectCandidatesLoaded.current = key;
    const rows = recognition.candidates.map((candidate) => ({ ...candidate, checked: true }));
    setCandidates(rows);
    const draftRows = recognition.candidates.map((item) => ({
      page: item.page,
      row: String(item.row),
      ...(item.episode !== null ? { episode: item.episode } : {}),
      scene: item.scene,
      shot: item.shot,
      take: item.take,
      status: item.status,
      note: item.note,
    }));
    setFormat('json');
    setContent(JSON.stringify(draftRows, null, 2));
    setEditing(true);
    setNotice('项目场记已在后台逐页识别完成，共 ' + recognition.candidates.length + ' 条候选，请核对后填入未保存草稿。');
  }, [recognition, projectId, candidates.length, model]);

  async function ingest() {
    if (lock.current || !model) return;
    const invalid = validatePaperInput(content, format);
    if (invalid) {
      setError(invalid);
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await client.request(projectId, { content, format, expected_revision: model.revision });
      if (mounted.current) {
        setModel(next);
        setEditing(false);
        setFocusSource((value) => value + 1);
        setNotice(next.import_status === 'already_imported' ? '相同转录内容已导入，没有重复新增。' : '转录原文已保存，仍需逐行核对；没有写入正式场记。');
      }
    } catch (e) {
      if (mounted.current) {
        setError(String(e instanceof Error ? e.message : e));
        setModel(null);
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const row = model?.rows.find((item) => item.paper_row_id === selected);

  useEffect(() => {
    onSelect?.(row && model ? { row, revision: model.revision } : null);
  }, [row, model, onSelect]);

  function updateCandidate(index: number, patch: Partial<ReviewCandidate>) {
    setCandidates((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, ...patch } : candidate));
  }

  function applyCandidates() {
    const checkedCandidates = candidates.filter((candidate) => candidate.checked).map(({ checked: _checked, ...candidate }) => ({ ...candidate, authority: false as const }));
    if (!checkedCandidates.length || !onApplyDraftCandidates) return;
    onApplyDraftCandidates(checkedCandidates);
    setCandidates([]);
    setNotice('');
    close();
  }

  return (
    <section className="slate-paper-intake">
      {!hideTrigger ? (
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          className={open ? 'is-active' : undefined}
          onClick={() => {
            if (openProp === undefined) setUncontrolledOpen((value) => !value);
            onOpenChange?.(!open);
          }}
        >纸面场记</button>
      ) : null}
      {open ? <>
        <div className="paper-intake-backdrop" aria-hidden="true" onClick={close} />
        <div className="paper-intake-body" role="dialog" aria-label="纸面与照片场记">
          <header className="paper-intake-head"><strong>纸面 / 照片场记</strong><button type="button" className="secondary paper-intake-close" onClick={close}>关闭</button></header>

          <section className="paper-photo-hero" aria-label="照片场记导入">
            <div className="paper-photo-copy">
              <h2>上传场记 PDF 或照片</h2>
              <p>支持片场场记 PDF（文字版或扫描版）与手写照片。AI 提取集·场·镜·次与备注后先在此核对，确认后填入未保存草稿（不会自动保存）。</p>
            </div>
            <input ref={photoInputRef} type="file" accept=".pdf,application/pdf,image/jpeg,image/png,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void extractPhoto(file); }} />
            <button type="button" className="paper-photo-upload" disabled={busy} onClick={() => photoInputRef.current?.click()}>选择场记 PDF / 照片（AI 提取）</button>
          </section>

          {recognition?.slate_attached ? (
            <section className="paper-recognition-status" aria-label="项目场记后台识别">
              <strong>项目附带场记：{recognition.slate_name || '场记文件'}</strong>
              {recognition.status === 'queued' || recognition.status === 'running' ? (
                <p role="status">后台逐页识别中 {recognition.pages_done}/{recognition.pages_total || '?'}；可以关闭本窗口，完成后会提示核对。</p>
              ) : recognition.status === 'completed' ? (
                <p role="status">识别完成，共 {recognition.candidates.length} 条候选，请在下方核对后填入草稿。</p>
              ) : recognition.status === 'failed' ? (
                <p role="alert">识别失败：{recognition.error || '请检查视觉模型设置后重试'}</p>
              ) : null}
              {recognition.warning ? <p role="status">{recognition.warning}</p> : null}
              {(recognition.status === 'none' || recognition.status === 'failed' || recognition.status === 'cancelled') && onStartRecognition ? (
                <button type="button" disabled={recognitionBusy || busy} onClick={onStartRecognition}>{recognitionBusy ? '提交中…' : '开始后台识别'}</button>
              ) : null}
            </section>
          ) : null}

          {candidates.length > 0 ? (
            <section className="paper-candidates-review" aria-label="照片场记候选核对">
              <div className="paper-candidates-table-wrap">
                <table>
                  <thead><tr><th scope="col">选择</th><th scope="col">集</th><th scope="col">场号</th><th scope="col">镜号</th><th scope="col">次号</th><th scope="col">状态</th><th scope="col">备注</th></tr></thead>
                  <tbody>{candidates.map((candidate, index) => <tr key={candidate.page + '-' + candidate.row + '-' + index}>
                    <td><input aria-label={'选择第 ' + (index + 1) + ' 条候选'} type="checkbox" checked={candidate.checked} onChange={(event) => updateCandidate(index, { checked: event.target.checked })} /></td>
                    <td><input aria-label={'第 ' + (index + 1) + ' 条候选集'} value={candidate.episode ?? ''} onChange={(event) => updateCandidate(index, { episode: event.target.value ? Number(event.target.value) : null })} /></td>
                    <td><input aria-label={'第 ' + (index + 1) + ' 条候选场号'} value={candidate.scene} onChange={(event) => updateCandidate(index, { scene: event.target.value })} /></td>
                    <td><input aria-label={'第 ' + (index + 1) + ' 条候选镜号'} value={candidate.shot} onChange={(event) => updateCandidate(index, { shot: event.target.value })} /></td>
                    <td><input aria-label={'第 ' + (index + 1) + ' 条候选次号'} value={candidate.take} onChange={(event) => updateCandidate(index, { take: event.target.value })} /></td>
                    <td><select aria-label={'第 ' + (index + 1) + ' 条候选状态'} value={candidate.status} onChange={(event) => updateCandidate(index, { status: event.target.value as PaperVlmCandidate['status'] })}>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
                    <td><input aria-label={'第 ' + (index + 1) + ' 条候选备注'} value={candidate.note} onChange={(event) => updateCandidate(index, { note: event.target.value })} /></td>
                  </tr>)}</tbody>
                </table>
              </div>
              <footer><span>已选 {candidates.filter((candidate) => candidate.checked).length} / {candidates.length} 条</span><div><button type="button" className="paper-primary" disabled={!candidates.some((candidate) => candidate.checked) || !onApplyDraftCandidates} onClick={applyCandidates}>填入场记草稿 ({candidates.filter((candidate) => candidate.checked).length})</button><button type="button" className="secondary" onClick={() => setCandidates([])}>清空候选</button></div></footer>
            </section>
          ) : null}

          {error ? <p role="alert">{error}</p> : null}
          {busy || notice ? <p role="status">{busy ? '正在处理场记来源…' : notice}</p> : null}

          <details className="paper-advanced-section">
            <summary>高级导入（PDF 单页识别 · 粘贴 JSON/CSV · 来源核对）</summary>
            <div className="paper-advanced-body">
              <SlatePdfDraft key={projectId} projectId={projectId} baseUrl={baseUrl} onImported={() => void load()} />
              {model ? <div className="paper-source-bar"><label>来源行<select ref={sourceRef} value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">使用当前人工场记（不选纸面来源）</option>{model.rows.map((item) => <option key={item.paper_row_id} value={item.paper_row_id}>文档 {model.documents.findIndex((document) => document.document_id === item.document_id) + 1} · 页 {item.page || '未填'} / 行 {item.row || '未填'} · 场 {item.normalized_fields.scene || '待核对'}</option>)}</select></label><button type="button" disabled={busy} onClick={() => void load()}>刷新来源</button><small>共 {model.summary.total_rows} 行 · 待核对 {model.summary.review_required} 行 · 可准备候选 {model.summary.candidate_ready} 行</small></div> : <button type="button" disabled={busy} onClick={() => void load()}>刷新来源</button>}
              <details className="paper-paste" open={editing} onToggle={(event) => setEditing(event.currentTarget.open)}><summary>粘贴转录内容</summary>
                <div className="paper-paste-fields"><label>转录格式<select value={format} disabled={busy} onChange={(event) => setFormat(event.target.value as 'json' | 'csv')}><option value="json">JSON</option><option value="csv">CSV</option></select></label>
                  <label>转录原文<textarea rows={3} value={content} disabled={busy} onChange={(event) => { const next = event.target.value; if (new TextEncoder().encode(next).length <= 2000000) { setContent(next); setError(''); } else setError('内容超过 2 MB，未接收此次粘贴。'); }} placeholder={'[{"page":"1","row":"1","scene":"012","shot":"3","take":"2"}]'} /></label>
                  <small>最多 2 MB、2000 行。保留页、行及前导零；不做 OCR 或自动确认。</small>
                  <div className="paper-paste-actions"><button type="button" disabled={busy || !model || !!validatePaperInput(content, format)} onClick={() => void ingest()}>导入转录原文</button></div>
                </div>
              </details>
              {model ? <><small>可准备候选不代表已匹配；原 PDF 尚未在本机验证。</small>{row ? <div>{model.documents.find((document) => document.document_id === row.document_id) ? <SlatePaperOriginal key={projectId + ':' + row.paper_row_id + ':' + model.revision} projectId={projectId} row={row} document={model.documents.find((document) => document.document_id === row.document_id)!} revision={model.revision} /> : null}{model.documents.find((document) => document.document_id === row.document_id) ? <PaperSourceMatch baseUrl={baseUrl} key={'match:' + projectId + ':' + row.paper_row_id + ':' + model.revision} projectId={projectId} row={row} document={model.documents.find((document) => document.document_id === row.document_id)!} revision={model.revision} /> : null}<details className="paper-raw"><summary>查看原始转录单元格</summary><dl tabIndex={0} aria-label="原始转录单元格">{row.raw_cells.map((cell, index) => <div key={index}><dt>{cell.cell}</dt><dd>{typeof cell.raw === 'string' ? cell.raw : JSON.stringify(cell.raw)}</dd></div>)}</dl></details><p>{row.candidate_ready ? '已选择此转录行。请在现有检视区选择真实原片附件，再准备区间；尚未确认。' : '此行有来源或转录疑点，需核对后再准备区间。'}</p>{row.review_reasons.length ? <details><summary>查看核对原因</summary><ul>{row.review_reasons.map((reason) => <li key={reason}>{reason === 'paper_scene_shorthand_requires_review' ? '纸面场号是简写符号，需核对明确场号。' : reason}</li>)}</ul></details> : null}</div> : null}</> : null}
            </div>
          </details>
        </div>
      </> : null}
    </section>
  );
}
