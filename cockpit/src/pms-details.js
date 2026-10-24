// Numeric daily OPERA columns proved present in the hotel's existing report.
// Non-deduct blocks are separate, never added to sold rooms or deducted twice.
export const DETAIL_FIELDS = {
  effective_inventory: 'CF_CALC_INV_ROOMS', occupied_rooms: 'CF_CALC_OCC_ROOMS',
  out_of_order: 'CF_OOO_ROOMS', individual_rooms: 'IND_DEDUCT_ROOMS',
  individual_non_deduct_rooms: 'IND_NON_DEDUCT_ROOMS', group_rooms: 'GRP_DEDUCT_ROOMS',
  group_non_deduct_rooms: 'GRP_NON_DEDUCT_ROOMS', individual_revenue: 'IND_DEDUCT_REVENUE',
  individual_non_deduct_revenue: 'IND_NON_DEDUCT_REVENUE', group_revenue: 'GRP_DEDUCT_REVENUE',
  group_non_deduct_revenue: 'GRP_NON_DEDUCT_REVENUE', arrivals: 'ARRIVAL_ROOMS',
  departures: 'DEPARTURE_ROOMS', no_show: 'NO_SHOW_ROOMS', complimentary: 'COMPLIMENTARY_ROOMS',
  house_use: 'HOUSE_USE_ROOMS', day_use: 'DAY_USE_ROOMS', persons: 'NO_PERSONS',
};
export function detailErrors(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Object.keys(d).length) return ['numeric details required'];
  return Object.entries(d).flatMap(([k,v]) => !Object.hasOwn(DETAIL_FIELDS,k)
    || (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || (!k.includes('revenue') && v < 0)))
    ? ['invalid daily detail field'] : []);
}
const ratio = (a,b,scale=1) => Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a/b*scale : null;
const close = (a,b,tolerance=0.01) => Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a-b) <= tolerance : null;
export function operatingDetails(row) {
  const d=row.details;
  if (!d) return null;
  const effectiveOccupancy=ratio(d.occupied_rooms,d.effective_inventory,100);
  return { ...d, effective_occupancy:effectiveOccupancy,
    effective_revpar:ratio(row.room_revenue,d.effective_inventory),
    individual_adr:ratio(d.individual_revenue,d.individual_rooms),
    group_adr:ratio(d.group_revenue,d.group_rooms),
    // Unallocated capacity after report occupancy, not a saleable-room promise.
    effective_headroom: Number.isFinite(d.effective_inventory) && Number.isFinite(d.occupied_rooms)
      ? d.effective_inventory-d.occupied_rooms : null,
    reconciliation: {
      inventory: close(Number.isFinite(row.inventory) && Number.isFinite(d.out_of_order) ? row.inventory-d.out_of_order : null,d.effective_inventory),
      occupancy: close(effectiveOccupancy,row.reported_occupancy),
      deducted_rooms: close(Number.isFinite(d.individual_rooms) && Number.isFinite(d.group_rooms) ? d.individual_rooms+d.group_rooms : null,row.rooms_sold),
      deducted_revenue: close(Number.isFinite(d.individual_revenue) && Number.isFinite(d.group_revenue) ? d.individual_revenue+d.group_revenue : null,row.room_revenue),
    } };
}
