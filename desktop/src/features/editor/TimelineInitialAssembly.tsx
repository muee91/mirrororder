import { localizedEditorialText } from "./timelineWorkbenchSupport";

export function TimelineInitialAssembly(props: { [key: string]: any }) {
  const { snapshot, proposal, timebaseDetected, plan, rateNumerator, setRateNumerator, rateDenominator, setRateDenominator, busy, confirmProposal, replaceProposalArmed, frameRate } = props;
  return (
    <details className="timeline-proposal production-panel editorial-initial-assembly" open={!snapshot}>
      <summary>
        <span><strong>初始顺片</strong><small>根据人工选片、场记范围与剧本顺序生成一次性的剪辑起点</small></span>
        <em>{proposal?.included.length ?? 0} 段可建立 · {proposal?.skipped.length ?? 0} 段待决</em>
      </summary>
      <div className="editorial-initial-body">
        <div className="timeline-proposal-heading">
          <div><p className="eyebrow">只生成起点，不持续覆盖人工剪辑</p><strong>{snapshot ? "当前已有剪辑；重建需要二次确认" : "确认后建立本机剪辑"}</strong></div>
          <div className="timeline-fps" title={timebaseDetected ? `来自 ${plan?.timebase?.source ?? "项目"}` : "当前来源没有权威时间基，需要人工确认"}>
            <span>时间基 {timebaseDetected ? "· 项目识别" : "· 请确认"}</span>
            <label>分子 <input type="number" min={1} max={120000} value={rateNumerator} placeholder="24000" onChange={(event) => setRateNumerator(event.target.value)} /></label>
            <label>分母 <input type="number" min={1} max={10000} value={rateDenominator} placeholder="1001" onChange={(event) => setRateDenominator(event.target.value)} /></label>
          </div>
          <button type="button" className={snapshot ? "danger-quiet" : undefined} disabled={busy || !proposal || proposal.commands.length === 0} onClick={() => void confirmProposal()}>
            {snapshot ? (replaceProposalArmed ? "再次确认重建" : "重新生成初始顺片") : "建立初始顺片"}
          </button>
        </div>
        {!frameRate ? <div className="proposal-warnings"><span>未确认时间基，不会建立剪辑。</span></div> : null}
        {replaceProposalArmed ? <div className="proposal-warnings"><span>⚠️ 再次确认会替换当前剪辑并清空撤销/重做历史。</span></div> : null}
        <div className="proposal-warnings">{(proposal?.warnings ?? []).map((warning: string) => <span key={warning}>{localizedEditorialText(warning)}</span>)}</div>
        {proposal?.skipped.length ? <details><summary>查看 {proposal.skipped.length} 个未进入初始顺片的块</summary><div className="proposal-skipped">{proposal.skipped.slice(0, 30).map((row: any) => <span key={row.blockId}><code>{row.segmentId || row.blockId}</code> · {localizedEditorialText(row.reason)}</span>)}</div></details> : null}
      </div>
    </details>
  );
}
