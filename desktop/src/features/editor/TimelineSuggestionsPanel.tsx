import type { TimelineWorkbenchProps } from "./timelineWorkbenchProps";

type SuggestionsPanelProps = Pick<TimelineWorkbenchProps,
  "editorialSuggestions" | "assistantStatus" | "busy" | "refreshAssistantSuggestions" | "locateClip">;

export function TimelineSuggestionsPanel(props: SuggestionsPanelProps) {
  const { editorialSuggestions, assistantStatus, busy, refreshAssistantSuggestions, locateClip } = props;
  return (
    <aside className="production-panel editorial-suggestions">
      <div className="editorial-section-heading"><div><p className="eyebrow">只读建议层</p><strong>智能建议</strong><span>建议不会自动改写选片或时间线</span></div><div className="editorial-suggestion-heading-actions"><small>{editorialSuggestions.length + (assistantStatus?.items?.length ?? 0)} 项</small><button type="button" className="secondary" disabled={busy} onClick={() => void refreshAssistantSuggestions()}>刷新小镜建议</button></div></div>
      <div className="editorial-suggestion-list">
        {editorialSuggestions.map((suggestion) => <article className={`editorial-suggestion tone-${suggestion.tone}`} key={suggestion.id}><div><span>规则检查</span><strong>{suggestion.title}</strong><p>{suggestion.detail}</p></div>{suggestion.clipId ? <button type="button" className="secondary" onClick={() => locateClip(suggestion.clipId)}>定位片段</button> : null}</article>)}
        {(assistantStatus?.items ?? []).slice(0, 8).map((item, index) => <article className="editorial-suggestion tone-info" key={String(item.item_id ?? `assistant-${index}`)}><div><span>小镜建议</span><strong>{String(item.title ?? item.summary ?? "项目建议")}</strong>{item.title && item.summary ? <p>{String(item.summary)}</p> : null}</div></article>)}
        {!editorialSuggestions.length && !(assistantStatus?.items?.length) ? <p className="empty-copy">当前没有需要突出显示的剪辑建议。建议层只读，不拥有剪辑 authority。</p> : null}
      </div>
    </aside>
  );
}
