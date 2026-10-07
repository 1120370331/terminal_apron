import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bot, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, RefreshCw, Save, Settings2, ShieldCheck } from "lucide-react";
import type { CodexDailyUsage, CodexGlobalSettings, CodexInfo, CodexQuotaWindow } from "../../shared/codexInfoTypes";
import { taskModeApi } from "./taskModeApi";
import { dailyTokens, monthDays, shiftDay, shiftMonth, todayKey, tokenText, windowLabel } from "./codexUsageView";
import "./codexInfo.css";
import type { RelayUsageRates } from "../../shared/taskUsageTypes";

export function CodexInfoPage({ onOpenAgentSettings }: { onOpenAgentSettings: () => void }) {
  const [info, setInfo] = useState<CodexInfo | null>(null);
  const [tab, setTab] = useState<"usage" | "settings">(new URLSearchParams(window.location.search).get("codexTab") === "settings" ? "settings" : "usage");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState(30);
  const [selected, setSelected] = useState("");
  const [month, setMonth] = useState(todayKey().slice(0, 7));
  const sequence = useRef(0);
  const mounted = useRef(true);

  const refresh = async (force = false) => {
    const request = ++sequence.current;
    setRefreshing(true);
    try {
      const next = await taskModeApi.codexInfo(force);
      if (!mounted.current || request !== sequence.current) return;
      setInfo(next); setError("");
      setSelected(previous => previous || next.usage?.latestDate || todayKey());
    } catch (cause) {
      if (mounted.current && request === sequence.current) setError(cause instanceof Error ? cause.message : "Codex 信息读取失败");
    } finally { if (mounted.current && request === sequence.current) setRefreshing(false); }
  };
  useEffect(() => {
    mounted.current = true; void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60000);
    return () => { mounted.current = false; sequence.current++; clearInterval(timer); };
  }, []);

  const daily = info?.usage?.daily ?? null;
  const today = todayKey();
  const period = useMemo(() => Array.from({ length: range }, (_, index) => shiftDay(today, index - range + 1)), [today, range]);
  const total = daily === null ? null : daily.filter(day => period.includes(day.date)).reduce((sum, day) => sum + day.tokens, 0);
  const quotas = info?.quotas?.flatMap(quota => [quota.primary, quota.secondary].filter((window): window is CodexQuotaWindow => Boolean(window)).map((window, index) => ({ ...window, bucket: quota.name, key: `${quota.id}-${index}` }))) ?? [];
  const dailyQuotaAvailable = quotas.some(window => window.windowMinutes === 1440);
  const selectDay = (date: string) => { setSelected(date); setMonth(date.slice(0, 7)); };
  const moveMonth = (amount: number) => {
    const next = shiftMonth(month, amount);
    setMonth(next);
    setSelected(daily?.filter(day => day.date.startsWith(next)).at(-1)?.date || `${next}-01`);
  };
  const sectionNames = { account: "账户", quotas: "额度", usage: "Token 用量", settings: "Codex 设置", models: "模型列表" };

  return <section className="ci-page" aria-label="Codex 信息">
    <header className="ci-heading"><div><span className="ci-eyebrow">CODEX</span><h1>Codex 信息</h1><p className="tp-page-sub">账户额度、Token 活动和本机默认设置。</p></div><button className="tp-button" onClick={() => void refresh(true)} disabled={refreshing}><RefreshCw className={refreshing ? "spin" : ""} />{refreshing ? "读取中…" : "刷新"}</button></header>
    <div className="ci-tabs" role="tablist" aria-label="Codex 信息视图"><button role="tab" aria-selected={tab === "usage"} onClick={() => setTab("usage")}><Activity />用量概览</button><button role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")}><Settings2 />Codex 设置</button></div>
    {error && <div className="tm-error" role="alert">{error}</div>}
    {!info ? <div className="tp-empty">{error ? "请点击刷新重试。" : "正在读取 Codex 账户与用量…"}</div> : <>
      <div className="ci-account"><div className="ci-account-icon"><Bot /></div><div><strong>{info.account?.type === "chatgpt" ? "ChatGPT 账户" : info.account?.type === "apiKey" ? "API Key 登录" : info.account?.type || "尚未读取到账户"}</strong><p>{info.account?.email || (info.account ? "使用本机 Codex 登录状态" : "请检查本机 Codex 是否已登录")}</p></div>{info.account?.plan && <span className="ci-plan">{info.account.plan.toUpperCase()}</span>}<span className="ci-updated"><Clock3 />{new Date(info.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} 更新</span></div>
      {info.errors.length > 0 && <div className="ci-read-errors" role="status">{info.errors.map(item => <p key={item.section}><strong>{sectionNames[item.section]}：</strong>{item.message}</p>)}</div>}
      {tab === "settings" ? <><CodexSettingsForm info={info} onSaved={() => void refresh(true)} onOpenAgentSettings={onOpenAgentSettings} /><RelayRatesForm /></> : <>
        <section className="ci-section" aria-label="账户额度"><div className="ci-section-head"><h2><ShieldCheck />账户额度</h2><span>按 Codex 当前计费窗口</span></div>
          {quotas.length > 0 ? <div className="ci-quotas">{quotas.map(quota => <article className="ci-quota" key={quota.key}><div><span>{windowLabel(quota.windowMinutes)}</span><small>{quota.bucket === "codex" ? "Codex" : quota.bucket}</small></div><strong>{Math.max(0, 100 - quota.usedPercent).toLocaleString()}<span>% 剩余</span></strong><div className="ci-quota-track" role="progressbar" aria-label={`${windowLabel(quota.windowMinutes)}已用比例`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={quota.usedPercent}><i style={{ width: `${quota.usedPercent}%` }} data-high={quota.usedPercent >= 90} /></div><p>已用 {quota.usedPercent}%{quota.resetsAt && <> · {new Date(quota.resetsAt).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 重置</>}</p></article>)}</div> : <p className="ci-empty">当前账户未提供额度窗口。请刷新或检查登录方式。</p>}
          {!dailyQuotaAvailable && <p className="ci-footnote">Codex 未返回单独的日限额；上方显示实际额度窗口，今日 Token 用量见下方。</p>}
        </section>
        <div className="ci-metrics"><Metric label="今日 Token" value={dailyTokens(daily, today)} note={dailyTokens(daily, today) === null ? "今日数据尚未同步" : today} /><Metric label={`最近 ${range} 天`} value={total} note="已返回的每日记录合计" /><Metric label="账户累计 Token" value={info.usage?.lifetimeTokens ?? null} note="Codex 账户累计统计" /><Metric label="连续使用" value={info.usage?.currentStreakDays ?? null} note="天" plain /></div>
        <section className="ci-section ci-trend" aria-label="Token 消耗曲线"><div className="ci-section-head"><h2><Activity />Token 消耗曲线</h2><div className="ci-range" aria-label="曲线时间范围">{[7, 30, 90].map(days => <button key={days} aria-pressed={range === days} onClick={() => setRange(days)}>{days} 天</button>)}</div></div>
          {daily?.length ? <UsageChart daily={daily} dates={period} selected={selected} onSelect={selectDay} /> : <p className="ci-empty">Codex 暂未返回每日 Token 记录。</p>}
          <p className="ci-footnote">点击曲线上的日期查看当天用量；未返回的数据保留为空。</p>
        </section>
        <section className="ci-section" aria-label="Token 用量日历"><div className="ci-section-head"><h2><CalendarDays />用量日历</h2><div className="ci-month-nav"><button aria-label="上一个月" onClick={() => moveMonth(-1)}><ChevronLeft /></button><strong>{month.replace("-", " 年 ")} 月</strong><button aria-label="下一个月" disabled={month >= today.slice(0, 7)} onClick={() => moveMonth(1)}><ChevronRight /></button></div></div>
          <div className="ci-calendar-layout"><UsageCalendar daily={daily} month={month} selected={selected} onSelect={setSelected} /><SelectedDay daily={daily} selected={selected} /></div>
        </section>
        <p className="ci-source">数据来自 Codex 官方账户接口，按其返回日期统计。{info.usage?.latestDate && <>最新用量记录：{info.usage.latestDate}。</>}新活动可能延迟同步；Token 用量与账户额度使用不同统计口径。</p>
      </>}
    </>}
  </section>;
}

function RelayRatesForm() {
  const [currency, setCurrency] = useState<RelayUsageRates["currency"]>("USD");
  const [inputs, setInputs] = useState({ inputPerMillion: "", cachedInputPerMillion: "", outputPerMillion: "" });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
  useEffect(() => { let alive = true; void taskModeApi.usageRates().then(rates => { if (alive && rates) { setCurrency(rates.currency); setInputs({ inputPerMillion: String(rates.inputPerMillion), cachedInputPerMillion: String(rates.cachedInputPerMillion), outputPerMillion: String(rates.outputPerMillion) }); } }).catch(() => { if (alive) setError("中转费率读取失败，请刷新后重试。"); }).finally(() => { if (alive) setLoading(false); }); return () => { alive = false; }; }, []);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setError(""); setNotice("");
    if (Object.values(inputs).some(value => !value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0)) { setError("请填写三项每 M Token 的实际费率；免费项可填 0。"); return; }
    setBusy(true);
    try { await taskModeApi.saveUsageRates({ currency, inputPerMillion: Number(inputs.inputPerMillion), cachedInputPerMillion: Number(inputs.cachedInputPerMillion), outputPerMillion: Number(inputs.outputPerMillion) }); setNotice("中转费率已保存，任务和对话将显示预估已消耗金额。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存中转费率失败"); }
    finally { setBusy(false); }
  };
  return <section className="ci-section ci-relay-rates" aria-label="中转费用估算"><div className="ci-section-head"><h2><Activity />中转费用估算</h2></div><p className="ci-settings-note">服务未返回金额时，使用这组统一费率估算中转消耗。请填写中转服务的实际单价；费用以最终账单为准。</p><form onSubmit={event => void save(event)}><fieldset disabled={loading || busy}><div className="ci-settings-grid"><label className="tm-field">币种<select className="tp-select" value={currency} onChange={event => { setCurrency(event.target.value as RelayUsageRates["currency"]); setNotice(""); }}><option value="USD">USD · 美元</option><option value="CNY">CNY · 人民币</option></select></label>{([ ["inputPerMillion", "非缓存输入 / M Tokens"], ["cachedInputPerMillion", "缓存命中输入 / M Tokens"], ["outputPerMillion", "输出 / M Tokens"] ] as const).map(([key, label]) => <label key={key} className="tm-field">{label}<input className="tp-input" type="number" min="0" max="1000000" step="any" required placeholder="填写实际单价" value={inputs[key]} onChange={event => { setInputs(previous => ({ ...previous, [key]: event.target.value })); setNotice(""); }} /></label>)}</div><button className="tp-button tp-primary" type="submit"><Save />{busy ? "保存中…" : loading ? "读取中…" : "保存中转费率"}</button></fieldset></form>{error && <p className="tm-error" role="alert">{error}</p>}{notice && <p className="ci-save-notice" role="status"><Check />{notice}</p>}</section>;
}

function Metric({ label, value, note, plain = false }: { label: string; value: number | null; note: string; plain?: boolean }) {
  return <div className="ci-metric"><span>{label}</span><strong title={value === null ? "未返回" : value.toLocaleString()}>{plain && value !== null ? value.toLocaleString() : tokenText(value)}</strong><small>{note}</small></div>;
}

function UsageChart({ daily, dates, selected, onSelect }: { daily: CodexDailyUsage[]; dates: string[]; selected: string; onSelect: (date: string) => void }) {
  const values = new Map(daily.map(day => [day.date, day.tokens]));
  const maximum = Math.max(1, ...dates.map(date => values.get(date) ?? 0));
  const points = dates.map((date, index) => ({ date, value: values.get(date), x: 58 + index / Math.max(1, dates.length - 1) * 660, y: 205 - (values.get(date) ?? 0) / maximum * 165 }));
  let connected = false;
  const path = points.map(point => { if (point.value === undefined) { connected = false; return ""; } const command = connected ? "L" : "M"; connected = true; return `${command}${point.x},${point.y}`; }).join(" ");
  const picked = points.find(point => point.date === selected);
  return <div className="ci-chart"><svg viewBox="0 0 740 250" role="group" aria-label="每日 Token 消耗曲线" onPointerDown={event => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * 740;
    const index = Math.max(0, Math.min(points.length - 1, Math.round((x - 58) / 660 * (points.length - 1))));
    if (points[index].value !== undefined) onSelect(points[index].date);
  }}>
    {[0, .25, .5, .75, 1].map(ratio => <g key={ratio}><line x1={58} y1={205 - ratio * 165} x2={718} y2={205 - ratio * 165} className="ci-chart-grid" /><text x={49} y={209 - ratio * 165} textAnchor="end">{tokenText(maximum * ratio)}</text></g>)}
    {picked?.value !== undefined && <line x1={picked.x} y1={35} x2={picked.x} y2={210} className="ci-chart-selection" />}
    <path d={path} className="ci-chart-line" />
    {points.filter(point => point.value !== undefined).map(point => <circle key={point.date} cx={point.x} cy={point.y} r={point.date === selected ? 5 : 4} className="ci-chart-point" data-selected={point.date === selected} role="button" tabIndex={0} aria-label={`${point.date}：${point.value!.toLocaleString()} Tokens`} onClick={() => onSelect(point.date)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(point.date); } }}><title>{point.date} · {point.value!.toLocaleString()} Tokens</title></circle>)}
    {[...new Set([0, Math.floor((points.length - 1) / 3), Math.floor((points.length - 1) * 2 / 3), points.length - 1])].map(index => <text key={index} x={points[index].x} y={237} textAnchor="middle">{points[index].date.slice(5)}</text>)}
  </svg><div className="ci-chart-caption"><span>{selected || "选择一个日期"}</span><strong>{tokenText(dailyTokens(daily, selected))} <small>Tokens</small></strong></div></div>;
}

function UsageCalendar({ daily, month, selected, onSelect }: { daily: CodexDailyUsage[] | null; month: string; selected: string; onSelect: (date: string) => void }) {
  const values = new Map(daily?.map(day => [day.date, day.tokens]) ?? []);
  const monthRecords = daily?.filter(day => day.date.startsWith(month)) ?? [];
  const max = Math.max(1, ...monthRecords.map(day => day.tokens));
  return <div><div className="ci-weekdays" aria-hidden="true">{["一", "二", "三", "四", "五", "六", "日"].map(day => <span key={day}>{day}</span>)}</div><div className="ci-calendar">{monthDays(month).map((date, index) => date ? <button key={date} data-date={date} data-level={values.has(date) ? values.get(date)! === 0 ? 0 : Math.max(1, Math.ceil(values.get(date)! / max * 4)) : "unknown"} aria-pressed={date === selected} disabled={date > todayKey()} aria-label={`${date}：${values.has(date) ? `${values.get(date)!.toLocaleString()} Tokens` : "未返回用量"}`} onClick={() => onSelect(date)}><span>{Number(date.slice(-2))}</span><small>{values.has(date) ? tokenText(values.get(date)!) : "—"}</small></button> : <span key={`blank-${index}`} />)}</div><div className="ci-calendar-footer"><span>{monthRecords.length ? `本月 ${tokenText(monthRecords.reduce((sum, day) => sum + day.tokens, 0))} Tokens · ${monthRecords.length} 天有记录` : "本月暂无用量记录"}</span><span className="ci-calendar-key">少{[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level} />)}多</span></div></div>;
}

function SelectedDay({ daily, selected }: { daily: CodexDailyUsage[] | null; selected: string }) {
  const tokens = dailyTokens(daily, selected);
  const previous = selected ? dailyTokens(daily, shiftDay(selected, -1)) : null;
  return <aside className="ci-selected-day"><span>所选日期</span><h3>{selected || "选择日历中的一天"}</h3><strong title={tokens?.toLocaleString()}>{tokenText(tokens)}</strong><p>Tokens</p>{tokens === null ? <p className="ci-footnote">该日期没有返回用量记录，可能尚未同步。</p> : <><p className="ci-day-exact">{tokens.toLocaleString()} Tokens</p>{previous !== null && <p className="ci-day-change">比前一天 {tokens - previous >= 0 ? "+" : "−"}{tokenText(Math.abs(tokens - previous))}{previous > 0 ? `（${((tokens - previous) / previous * 100).toFixed(1)}%）` : ""}</p>}</>}<small>统计范围：当前 Codex 账户</small></aside>;
}

function CodexSettingsForm({ info, onSaved, onOpenAgentSettings }: { info: CodexInfo; onSaved: () => void; onOpenAgentSettings: () => void }) {
  const defaults = info.settings?.values;
  const initial = defaults && { ...defaults, model: defaults.model || info.models.find(model => model.isDefault)?.id || info.models[0]?.id || "" };
  const [value, setValue] = useState<CodexGlobalSettings | null>(initial || null);
  const [version, setVersion] = useState(info.settings?.version ?? null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (!value && initial) { setValue(initial); setVersion(info.settings?.version ?? null); } }, [info.settings, info.models]);
  const selectedModel = info.models.find(model => model.id === value?.model);
  const update = <K extends keyof CodexGlobalSettings>(key: K, field: CodexGlobalSettings[K]) => { setValue(old => old && { ...old, [key]: field }); setNotice(""); };
  async function save() {
    if (!value) return;
    setBusy(true); setError(""); setNotice("");
    try { const result = await taskModeApi.saveCodexSettings({ ...value, expectedVersion: version }); setValue(result.values); setVersion(result.version); setNotice(JSON.stringify(result.values) === JSON.stringify(value) ? "已保存到本机 Codex，新会话使用这些默认设置。" : "已保存；部分默认值受本机或管理员配置覆盖，请核对下方显示值。"); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setBusy(false); }
  }
  if (!value) return <section className="ci-section"><p>暂时无法读取 Codex 设置，请先刷新。</p></section>;
  return <section className="ci-section ci-settings" aria-label="Codex 全局设置"><div className="ci-section-head"><h2><Settings2 />本机 Codex 默认设置</h2></div><p className="ci-settings-note">保存到本机 Codex，适用于后续新会话。Task Mode 的代理和任务设置会单独覆盖这些默认值。</p>{!info.canEditSettings && <p className="tm-error">只有 Apron 管理员可以修改本机全局设置。</p>}<fieldset disabled={busy || !info.canEditSettings}><div className="ci-settings-grid">
    <label className="tm-field">默认模型<select className="tp-select" value={value.model} onChange={event => { const model = info.models.find(model => model.id === event.target.value); update("model", event.target.value); if (model?.efforts.length && !model.efforts.includes(value.effort)) update("effort", model.defaultEffort || model.efforts[0]); }}>{!info.models.some(model => model.id === value.model) && <option value={value.model}>{value.model || "模型暂未加载"}</option>}{info.models.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label>
    <label className="tm-field">推理强度<select className="tp-select" value={value.effort} onChange={event => update("effort", event.target.value as CodexGlobalSettings["effort"])}>{["minimal", "low", "medium", "high", "xhigh"].map(effort => <option key={effort} value={effort} disabled={Boolean(selectedModel?.efforts.length && !selectedModel.efforts.includes(effort as CodexGlobalSettings["effort"]))}>{({ minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "最高" })[effort]}</option>)}</select></label>
    <label className="tm-field">执行审批<select className="tp-select" value={value.approvalsReviewer} onChange={event => update("approvalsReviewer", event.target.value as CodexGlobalSettings["approvalsReviewer"])}><option value="auto_review">Codex 代我审批</option><option value="user">由我手动审批</option></select></label>
    <label className="tm-field">执行速度<select className="tp-select" value={value.serviceTier} onChange={event => update("serviceTier", event.target.value as CodexGlobalSettings["serviceTier"])}><option value="default">标准</option><option value="priority">优先 · 依账户和模型支持</option></select></label>
  </div><button className="tp-button tp-primary" type="button" disabled={!value.model || !info.models.length} onClick={() => void save()}><Save />{busy ? "保存中…" : "保存 Codex 设置"}</button></fieldset>{error && <p className="tm-error" role="alert">{error}</p>}{notice && <p className="ci-save-notice" role="status"><Check />{notice}</p>}<div className="ci-agent-settings"><div><h3>Task Mode 执行设置</h3><p>任务代理、Worker、并发、审批和结果确认在代理设置中调整。</p></div><button className="tp-button" onClick={onOpenAgentSettings}>打开代理设置</button></div></section>;
}
