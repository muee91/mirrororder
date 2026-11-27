import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { HostConnection, ReviewAngle, ReviewScriptBlock, ReviewTakeGroup } from "../../api/host";
import { SpeechEvidenceClient, type SpeechEvidence } from "../../api/speechEvidence";
import { useNearViewportGate } from "../media/nearViewport";
import { reviewSourceClock } from "./reviewLocation";
import { matchesScriptSpeech, scriptSpeechClauses } from "../material-script/scriptSpeech";
import { confirmedOnTake } from "../material-script/actionDialogue";
import { StudioIcon } from "../../components/StudioIcons";
import { cameraPresentation } from "../media/cameraPresentation";
import { mediaCardFromAngle } from "../media/MirrorOrderMediaCard";
import { ReviewAngleFrame } from "./ReviewFragmentList";
import { ReviewQueueRow } from "./ReviewQueueRow";
import { ReviewAngleStatus, ReviewFootageStatus, ReviewSlateReference } from "./ReviewFootageStatus";
import { ReviewTeamFeedback, collectTakeTeamFeedback } from "./ReviewTeamFeedback";
import { finalDecision, type AngleSlateFact, type ReviewSlateFacts, type SlateReadState } from "./reviewFootageFacts";
import type { EditorialState } from "../../api/planning";
import type { ScriptTakeProjection } from "../material-script/model";
import { scriptLineText } from "../script/scriptSemantics";
import "./review-coverage-cards.css";

type LineRelation = "mapped" | "candidate" | "context";

function relationLabel(relation: LineRelation, take: ReviewTakeGroup): string {
  if (relation === "candidate") return "候选匹配";
  if (relation === "context") return "上下文关联";
  const { source, inherited } = take.effective_mapping;
  if (source === "human") return inherited ? "继承人工归属" : "人工归属";
  return source === "automatic" ? "自动归属" : "已有归属";
}

export interface ReviewCoverageCardsProps {
  takes: readonly ReviewTakeGroup[];
  activeBlock?: ReviewScriptBlock | null;
  blocksById: ReadonlyMap<string, ReviewScriptBlock>;
  projection?: ScriptTakeProjection;
  selectedGroupId: string | null;
  connection: Pick<HostConnection, "mediaUrl"> & Partial<Pick<HostConnection, "baseUrl">>;
  projectId: string;
  slateFacts?: ReadonlyMap<string, ReviewSlateFacts>;
  slateReadState?: SlateReadState;
  onOpenSlate?: (groupId: string, clipId?: string | null, recordId?: string) => void;
  takeLabel: (take: ReviewTakeGroup) => string;
  onWatch: (take: ReviewTakeGroup, clipId?: string, sourceTime?: number) => void;
  onCompare: (take: ReviewTakeGroup) => void;
  onOpenScript?: (take: ReviewTakeGroup, segmentId: string) => void;
  onChooseBlock: (block: ReviewScriptBlock) => void;
  onQuickDecision?: (groupId: string, state: EditorialState) => void | Promise<void>;
  angleEvidence?: (take: ReviewTakeGroup, angle: ReviewAngle) => { text: string; sourceStart?: number } | undefined;
}

function blockRelations(take: ReviewTakeGroup): Map<string, LineRelation> {
  const relations = new Map<string, LineRelation>();
  for (const id of take.effective_mapping.script_segment_ids) relations.set(id, "mapped");
  for (const candidate of take.candidates) {
    const ids = candidate.script_segment_ids?.length ? candidate.script_segment_ids : [candidate.script_segment_id];
    for (const id of ids) if (id && !relations.has(id)) relations.set(id, "candidate");
  }
  for (const id of take.context.script_segment_ids) if (!relations.has(id)) relations.set(id, "context");
  return relations;
}

function Passage({ text }: { text: string }) {
  const firstLines = text.split("\n", 3).slice(0, 2).join("\n");
  const excerpt = firstLines.slice(0, 110).trimEnd();
  if (excerpt.length >= text.length) return <p>{text}</p>;
  return <details className="review-coverage-passage">
    <summary><span className="review-coverage-excerpt">{excerpt}… </span>
      <span className="review-coverage-expand">展开全文</span><span className="review-coverage-collapse">收起全文</span>
    </summary>
    <p>{text}</p>
  </details>;
}

type SpeechCue = { text: string; sourceStart?: number };
type ReadSpeech = (clipId: string) => Promise<SpeechEvidence>;

function CoverageCamera({ angle, projectId, mediaUrl, aspectKey, aspects, suppliedCue, clauses, readSpeech, onWatch, slate, adjacent }: {
  angle: ReviewAngle; projectId: string; mediaUrl: string; suppliedCue?: SpeechCue; clauses: readonly string[];
  aspectKey: string; aspects: Map<string, number>;
  slate?: AngleSlateFact;
  readSpeech?: ReadSpeech; onWatch: (time?: number) => void; adjacent: boolean;
}) {
  const camera = cameraPresentation(angle.camera);
  const media = mediaCardFromAngle(angle);
  const previewId = useId();
  const availability = media.available === false ? "文件缺失" : !media.playbackUrl ? "待检查" : "";
  const [ref, visible] = useNearViewportGate<HTMLDivElement>(true);
  const [aspect, setAspect] = useState(() => aspects.get(aspectKey));
  const recordAspect = useCallback((next: number) => {
    if (!Number.isFinite(next) || next <= 0) return;
    aspects.set(aspectKey, next);
    setAspect(next);
  }, [aspects, aspectKey]);
  const [record, setRecord] = useState<{ projectId: string; data: SpeechEvidence } | null>(null);
  const shouldRead = Boolean(visible && clauses.length && !suppliedCue);
  useEffect(() => {
    if (!shouldRead || !readSpeech) return;
    let active = true;
    void readSpeech(angle.clip_id).then(data => { if (active) setRecord({ projectId, data }); }).catch(() => {});
    return () => { active = false; };
  }, [angle.clip_id, projectId, readSpeech, shouldRead]);
  const cue = useMemo(() => {
    if (suppliedCue) return suppliedCue;
    const data = record?.data;
    if (!data || record.projectId !== projectId || data.status !== "available" || data.clip_id !== angle.clip_id ||
      data.media_id !== angle.media_id || !readSpeech || !clauses.length) return undefined;
    const start = angle.playback.source_start ?? angle.source_start;
    const end = angle.playback.source_end ?? angle.source_end ?? (angle.duration > 0 ? start + angle.duration : Infinity);
    const match = data.segments.find((segment) => {
      if (segment.end <= start || segment.start >= end) return false;
      return matchesScriptSpeech(segment.text, clauses);
    });
    return match ? { text: match.text, sourceStart: Math.max(start, match.start) } : undefined;
  }, [angle, clauses, projectId, readSpeech, record, suppliedCue]);
  const time = cue?.sourceStart;
  const stamp = time === undefined ? "" : reviewSourceClock(time);
  return <div className="review-coverage-camera" ref={ref}
    data-frame={availability ? "unavailable" : aspect === undefined ? "pending" : aspect < 1 ? "portrait" : "measured"}
    style={{ "--review-camera-aspect": aspect ?? 1 } as CSSProperties}>
    <button type="button" title={media.name} aria-describedby={previewId} aria-label={`查看${camera.label} · ${media.name}${availability ? ` · ${availability}` : ""}`}
      onClick={() => onWatch(time)}>
      <ReviewAngleFrame angle={angle} sourceStart={time} mediaUrl={mediaUrl} onAspectChange={recordAspect} descriptionId={previewId} />
      <span className="review-coverage-camera-info">
        <span className="review-coverage-filename">{media.name}</span>
        {availability ? <small>{availability}</small> : <StudioIcon name="play" size={13} />}
      </span>
    </button>
    <ReviewAngleStatus fact={slate} camera={camera.label} />
    {cue?.text.trim() && <div className="review-coverage-angle-speech" aria-label={camera.label + "现场转写"}>
      {time !== undefined && media.playbackUrl ? <button type="button" className="review-cue-link"
        aria-label={`定位${camera.label}${adjacent ? "相邻台词" : "对白"} ${stamp} · ${cue.text}`} onClick={() => onWatch(time)}><time>{stamp}</time>{adjacent && "台词 · "}{cue.text}</button> :
        <Passage text={cue.text.trim()} />}
    </div>}
  </div>;
}

export function ReviewCoverageCards({
  takes, activeBlock, blocksById, projection, selectedGroupId, connection, projectId, slateFacts, slateReadState, onOpenSlate, takeLabel, onWatch, onCompare,
  onChooseBlock, onOpenScript, onQuickDecision, angleEvidence,
}: ReviewCoverageCardsProps) {
  const list = useRef<HTMLDivElement>(null);
  const selectedCard = useRef<HTMLElement>(null);
  const queueId = useId();
  const aspects = useMemo(() => new Map<string, number>(), [connection.baseUrl, projectId]);
  const clauses = useMemo(() => scriptSpeechClauses(activeBlock ?? undefined), [activeBlock]);
  const readSpeech = useMemo(() => {
    if (!connection.baseUrl) return undefined;
    const client = new SpeechEvidenceClient(connection.baseUrl);
    const cache = new Map<string, Promise<SpeechEvidence>>();
    return (clipId: string) => {
      let request = cache.get(clipId);
      if (!request) {
        request = client.evidence(projectId, clipId).catch((error) => { cache.delete(clipId); throw error; });
        cache.set(clipId, request);
      }
      return request;
    };
  }, [connection.baseUrl, projectId]);
  const [heights] = useState(() => new Map<string, number>());
  const selectedIndex = takes.findIndex(take => take.group_id === selectedGroupId);

  useLayoutEffect(() => {
    if (selectedCard.current) selectedCard.current.scrollIntoView?.({ block: "nearest" });
    else if (list.current) list.current.scrollTop = 0;
  }, [activeBlock?.segment_id, selectedGroupId, selectedIndex]);

  return <div className="review-coverage-card-list" ref={list} role="region" aria-label="素材组对照">
    {takes.map((take, index) => <ReviewQueueRow key={take.group_id} count={takes.length} index={index}
      selectedIndex={selectedIndex} queueId={queueId} rowKey={take.group_id} heights={heights} estimate={315}>
      {() => {
        const label = takeLabel(take);
        const sequence = label.match(/^(Take #\d+) · (.+)$/);
        const slate = slateFacts?.get(take.group_id);
        const recordedAngle = slate?.take ? undefined : take.angles.find(angle => slate?.angles.has(angle.clip_id));
        const relations = blockRelations(take);
        const availableBlocks = [...relations.keys()].flatMap(id => blocksById.get(id) ?? []);
        const block = activeBlock ?? availableBlocks[0];
        const relation = block ? relations.get(block.segment_id) : relations.values().next().value;
        const nearbyLines = activeBlock && projection?.dialogueByActionTake.get(activeBlock.segment_id)?.get(take.group_id);
        const nearbyActions = activeBlock && projection?.actionsByDialogue.get(activeBlock.segment_id)?.filter(action =>
          projection.dialogueByActionTake.get(action.segment_id)?.get(take.group_id)?.some(line => line.segment_id === activeBlock.segment_id));
        const adjacent = Boolean(nearbyLines?.length);
        const nearbyBlocks = nearbyLines ?? nearbyActions ?? [];
        const otherBlocks = availableBlocks.filter(item => item.segment_id !== block?.segment_id
          && !nearbyBlocks.some(nearby => nearby.segment_id === item.segment_id));
        const transcript = take.transcript.text.trim();
        const selected = take.group_id === selectedGroupId;
        const angles = [...take.angles].sort((a, b) => cameraPresentation(a.camera).sortOrder - cameraPresentation(b.camera).sortOrder);
        const hasScriptReference = Boolean(relation || adjacent || !activeBlock);
        const scriptHeading = hasScriptReference ? "剧本原句" : "剧本关联";
        const line = block && scriptLineText(block);
        const cameraClauses = nearbyLines?.flatMap(scriptSpeechClauses) ?? clauses;
        const actionConfirmed = block?.type === "action" && confirmedOnTake(take, block.segment_id);
        const possibleTogether = adjacent && relation !== "mapped";
        const confirmedTogether = actionConfirmed && nearbyLines?.some(item => confirmedOnTake(take, item.segment_id));
        let relationText = relation ? relationLabel(relation, take) : activeBlock ? "待核对" : "未归集";
        if (possibleTogether) relationText = "可能同拍 · 待核画面";
        else if (confirmedTogether) relationText = "已确认同拍";
        else if (block?.type === "action" && relation === "mapped" && !actionConfirmed) relationText += " · 动作待核";

        return <article className="review-coverage-card" aria-label={label} aria-current={selected ? "true" : undefined}
          ref={selected ? selectedCard : undefined}>
          <header className="review-coverage-card-head">
            <h3 title={label} aria-label={label}>{sequence ? <>{sequence[1]}<small className="review-take-source"> · {sequence[2]}</small></> : label}</h3>
            <div className="review-coverage-card-actions">
              {onOpenSlate && <button type="button" className="secondary mo-toolbar-button review-open-slate"
                onClick={() => onOpenSlate(take.group_id, recordedAngle?.clip_id, slate?.take?.record_id ||
                  (recordedAngle ? slate?.angles.get(recordedAngle.clip_id)?.record.record_id : undefined))}>查看场记</button>}
              {angles.length > 1 && <button type="button" className="secondary mo-toolbar-button review-coverage-compare"
                onClick={() => onCompare(take)}><StudioIcon name="sync-inspect" size={15} />多机位同看</button>}
            </div>
            <div className="review-coverage-card-facts">
              <ReviewFootageStatus take={take} facts={slate} readState={slateReadState} />
              <span className="review-coverage-relation" data-relation={possibleTogether ? "candidate" : relation}
                data-mapping-source={relation === "mapped" ? take.effective_mapping.source : undefined}>
                {relationText}
              </span>
            </div>
          </header>

          <div className="review-coverage-body">
            {angles.length ? <div className="review-coverage-cameras">
              {Array.from({ length: Math.ceil(angles.length / 3) }, (_, row) => (
                <div key={row} className="review-coverage-camera-row">{angles.slice(row * 3, row * 3 + 3).map(angle => {
                  const mediaUrl = connection.mediaUrl(projectId, angle.clip_id);
                  const aspectKey = JSON.stringify([projectId, angle.clip_id, angle.media_id, mediaUrl]);
                  return <CoverageCamera key={aspectKey} angle={angle} projectId={projectId} slate={slate?.angles.get(angle.clip_id)}
                    aspects={aspects} aspectKey={aspectKey} mediaUrl={mediaUrl} suppliedCue={adjacent ? undefined : angleEvidence?.(take, angle)}
                    clauses={cameraClauses} readSpeech={relation || adjacent ? readSpeech : undefined} adjacent={adjacent}
                    onWatch={(time) => time === undefined ? onWatch(take, angle.clip_id) : onWatch(take, angle.clip_id, time)} />;
                })}</div>
              ))}
            </div> : <p className="review-coverage-no-angles"><StudioIcon name="film" size={16} />这组素材尚无机位文件</p>}

            <div className="review-coverage-text">
              <ReviewSlateReference record={slate?.take} />
              <section className="review-script-reference" aria-label={scriptHeading}>
                <div className="review-coverage-text-head"><h4>{scriptHeading}</h4>
                  {block && !activeBlock && <button type="button" onClick={() => onChooseBlock(block)}>看这句的素材</button>}
                  {block && onOpenScript && <button type="button" onClick={() => onOpenScript(take, block.segment_id)}>
                    {adjacent && !confirmedTogether ? "去确认同拍" : activeBlock && relation !== "mapped" ? "去剧本关联" : "打开剧本"}
                  </button>}
                </div>
                {!hasScriptReference ? null : line ? <Passage text={line} /> : <p className="review-coverage-muted">
                  {block ? "该剧本段没有正文" : relations.size ? "对应剧本段尚未载入" : !blocksById.size ? "项目尚无剧本原文" : "尚未关联剧本原句"}
                </p>}
                {!!nearbyBlocks.length && <div className="review-coverage-neighbors" aria-label={adjacent ? "相邻台词" : "相邻动作"}>
                  <h5>{adjacent ? "相邻台词" : "相邻动作"}</h5>
                  {nearbyBlocks.map(other => <button type="button" key={other.segment_id} onClick={() => onChooseBlock(other)}>
                    <small>{adjacent ? (relations.get(other.segment_id) === "mapped" ? "台词已归属" : "台词候选")
                      : confirmedOnTake(take, other.segment_id) ? "动作已人工关联" : "待看画面"}</small>{scriptLineText(other)}
                  </button>)}
                </div>}
                {!!otherBlocks.length && <details className="review-coverage-other-lines"><summary>另有 {otherBlocks.length} 个关联剧本段</summary>
                  {otherBlocks.map(other => <button key={other.segment_id} type="button" onClick={() => onChooseBlock(other)}>
                    <small>{relationLabel(relations.get(other.segment_id)!, take)}</small>{scriptLineText(other)}
                  </button>)}
                </details>}
              </section>
              <section aria-label="现场对白摘录">
                <div className="review-coverage-text-head"><h4>现场对白摘录</h4>
                  {transcript && <small>{take.transcript.source === "candidate" ? "素材组 · 候选记录" : "素材组"}</small>}
                </div>
                {transcript ? <Passage text={transcript} /> : <p className="review-coverage-muted">暂无素材组对白摘录</p>}
              </section>
            </div>
            <ReviewTeamFeedback
              feedback={collectTakeTeamFeedback(take, blocksById)}
              onSeekComment={(clipId, sourceTime) => onWatch(take, clipId, sourceTime)}
            />
            {onQuickDecision ? (() => {
              const current = finalDecision(take).state;
              return (
                <div className="review-coverage-quick-decision" role="group" aria-label="选片决定">
                  {([["best", "首选"], ["keep", "保留"], ["reject", "废弃"]] as const).map(([value, text]) => (
                    <button
                      key={value}
                      type="button"
                      className={`secondary mo-toolbar-button${current === value ? ` is-selected state-${value}` : ""}`}
                      aria-pressed={current === value}
                      onClick={() => void onQuickDecision(take.group_id, current === value ? "unreviewed" : value)}
                    >
                      {text}
                    </button>
                  ))}
                  {current !== "unreviewed" ? (
                    <button
                      type="button"
                      className="secondary mo-toolbar-button"
                      onClick={() => void onQuickDecision(take.group_id, "unreviewed")}
                    >
                      清除
                    </button>
                  ) : null}
                </div>
              );
            })() : null}
          </div>
        </article>;
      }}
    </ReviewQueueRow>)}
  </div>;
}
