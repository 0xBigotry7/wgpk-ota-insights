// Shared deterministic presentation contracts: no guessed dates, inventory basis or currencies.
export function occupancyBand(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return value > 100 ? 10 : Math.max(0, Math.ceil(value / 10) - 1);
}
export function metricContext(m) {
  return { observed_on: m.day, source_as_of:m.source_as_of||null, source_date_basis:m.source_date_basis||null,
    reporting_window: m.period || null, stay_date: null,
    grain: m.period ? 'platform_reporting_window' : 'platform_observation',
    currency: /^[A-Z]{3}$/.test(m.unit || '') ? m.unit : null,
    comparison_basis: m.benchmark == null ? null : 'platform_reported_comparison',
    warning: '采样日不是入住日；平台统计窗口不能分摊为当前选中日数据' };
}
export function stayContext(revenue, selected) {
  const row = revenue?.days?.find(d => d.stay_date === selected);
  return { stay_date: row?.stay_date || null, value_kind: row?.kind || null,
    source_as_of: revenue?.source?.as_of || null,
    source_date_basis: revenue?.source ? revenue.source.as_of_basis || 'explicit_export_date' : null,
    received_at: revenue?.source?.received_at || null, freshness: revenue?.status || 'missing',
    currency: revenue?.source?.currency || null, inventory_basis: 'reported_inventory_unverified',
    tax_basis: 'unverified', snapshot_id: revenue?.source?.id || null,
    warnings: ['PMS未来报表值不是已核实OTB或RMS需求预测', '报表库存尚未确认物理/有效口径，不重复扣停用房', 'OTA窗口指标不属于该入住日'] };
}
export const INBOX_GROUPS = [
  { id: 'data_exception', label: '数据问题' },
  { id: 'business_investigation', label: '经营调查' },
  { id: 'information', label: '普通通知' },
];
const severity = { critical: 0, serious: 1, warning: 2, info: 3 };
export function organizeAlerts(alerts) {
  const unique = new Map();
  for (const a of alerts) {
    const category = ['data', 'collection'].includes(a.area) ? 'data_exception'
      : a.level === 'info' ? 'information' : 'business_investigation';
    // The rule and full reporting window remain part of the key. Different scopes are not duplicates.
    const key = JSON.stringify([category, a.property_id || null, a.platform, a.id, a.metric || null, a.stay_date || null]);
    const item = { ...a, category, dedupe_key: key };
    if (!unique.has(key) || (severity[a.level] ?? 3) < (severity[unique.get(key).level] ?? 3)) unique.set(key, item);
  }
  const all = [...unique.values()].sort((a,b) => INBOX_GROUPS.findIndex(g=>g.id===a.category) - INBOX_GROUPS.findIndex(g=>g.id===b.category)
    || (severity[a.level] ?? 3) - (severity[b.level] ?? 3));
  const shown = all.slice(0,20);
  return { alerts: shown, inbox: { total: all.length, shown: shown.length, truncated: all.length-shown.length,
    groups: INBOX_GROUPS.map(g=>({...g,count:shown.filter(a=>a.category===g.id).length})) } };
}
