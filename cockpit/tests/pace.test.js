import { test } from "node:test";
import assert from "node:assert/strict";
import { paceView, paceAlerts } from "../src/pace.js";
import { monitor } from "../src/monitor.js";

const row = (day, period, metric, value, benchmark = null) =>
  ({ day, platform: "booking", metric, period, label: "在手", value, benchmark, unit: metric === "pace_adr" ? "THB" : "间夜", page: "pace" });
const metrics = [
  row("2026-10-20", "stay_2026-11", "pace_room_nights", 400, 600),
  row("2026-10-27", "stay_2026-11", "pace_room_nights", 430, 610),
  row("2026-10-28", "stay_2026-11", "pace_room_nights", 425, 615),
  row("2026-10-28", "stay_2026-11", "pace_adr", 6500, 5000),
  row("2026-10-28", "stay_2026-12", "pace_room_nights", 700, 500),
  row("2026-10-28", "stay_2026-09", "pace_room_nights", 1, 1),          // past month: not shown
  row("2026-10-28", "last_30_days", "pace_room_nights", 9, 9),           // not a stay month: ignored
];

test("pace: per stay month vs last year, pickup only between our own snapshots of that month", () => {
  const v = paceView(metrics, "2026-10-28");
  const b = v.platforms[0];
  assert.deepEqual(b.months.map((m) => m.month), ["2026-11", "2026-12"]);
  const nov = b.months[0];
  assert.equal(nov.room_nights, 425);
  assert.equal(Math.round(nov.gap), -31);
  assert.deepEqual(nov.pickup_1d, { value: -5, from: "2026-10-27", to: "2026-10-28" });
  assert.deepEqual(nov.pickup_7d, { value: 25, from: "2026-10-20", to: "2026-10-28" });
  assert.equal(Math.round(nov.adr_gap), 30);
  assert.equal(nov.daily.at(-1).value, -5);
  assert.equal(nov.daily.find((d) => d.day === "2026-10-27").value, 30);
  assert.equal(b.months[1].pickup_1d, null);                              // one snapshot: no pickup, not zero
});

test("pace alerts: a trailing near month is serious and price-led, a strong month is a win", () => {
  const a = paceAlerts(paceView(metrics, "2026-10-28"));
  const nov = a.find((x) => x.id === "pace:booking:2026-11");
  assert.equal(nov.level, "serious");
  assert.match(nov.title, /少 31%，房价却高得多/);
  assert.ok(a.find((x) => x.id === "win:pace:booking:2026-12" && x.win));
  assert.ok(!a.some((x) => x.id.startsWith("pickup:")));                  // 7-day pickup is positive
});

test("monitor keeps pace months out of the generic peer-gap alerts", () => {
  const m = monitor({ metrics, runs: [{ id: "20261028-102000", outcome: "done" }] }, new Date("2026-10-28T05:00:00Z"));
  assert.ok(m.alerts.some((x) => x.id === "pace:booking:2026-11"));
  assert.ok(!m.alerts.some((x) => /^(gap|drop):booking\|pace_/.test(x.id)));
});

test("booked-within-90-days by stay month: our ADR vs peers, one rate alert listing the cheap months", () => {
  const b = (period, metric, value) => ({ day: "2026-10-28", platform: "booking", metric, period, label: "x", value, unit: "THB", benchmark: null, page: "pace-90d" });
  const rows = [["stay_2026-12", 466, 7697, 9928], ["stay_2027-01", 441, 7986, 10456], ["stay_2027-02", 176, 5384, 8334], ["stay_2027-04", 21, 5000, 9000]]
    .flatMap(([p, rn, adr, comp]) => [b(p, "pickup_90d_room_nights", rn), b(p, "pickup_90d_adr", adr), b(p, "pickup_90d_adr_comp", comp)]);
  const v = paceView(rows, "2026-10-28");
  const dec = v.platforms[0].months[0];
  assert.equal(dec.room_nights, null);
  assert.equal(dec.daily, null);                                         // rolling windows are never pickup
  assert.equal(Math.round(dec.booked_90d.adr_gap), -22);
  const a = paceAlerts(v);
  assert.equal(a.length, 1);
  assert.equal(a[0].id, "pace-rate:booking");
  assert.equal(a[0].level, "serious");
  assert.match(a[0].title, /12月、1月、2月/);                            // April: too few nights to call
});

test("event plan: campaign live date uses the longer of our and the peers' booking window", async () => {
  const { eventPlan, eventAlerts } = await import("../src/events.js");
  const w = [{ day: "2026-10-26", platform: "booking", metric: "book_window_days", period: "", value: 29.2, benchmark: 57.3 }];
  const plan = eventPlan(w, null, "2026-10-28");
  assert.equal(plan.lead_days, 57);
  const ru = plan.events.find((e) => e.id === "ru-ny-2027");
  assert.equal(ru.live_by, "2026-11-05");
  assert.equal(ru.status, "soon");
  assert.equal(plan.events.find((e) => e.id === "xmas-ny-2026").status, "late");
  const a = eventAlerts(plan);
  assert.ok(a.some((x) => x.id === "event:ru-ny-2027" && x.level === "warning"));
  assert.ok(a.some((x) => x.id === "event:xmas-ny-2026" && x.level === "serious"));
  assert.ok(!a.some((x) => x.id === "event:cny-2027"));                // live by 12-10: not yet
});

test("daily pace: next stay dates from the latest sample, kept out of the generic alerts", () => {
  const daily = [
    row("2026-10-27", "stay_2026-10-29", "pace_room_nights", 50, 40),
    row("2026-10-28", "stay_2026-10-29", "pace_room_nights", 60, 80),
    row("2026-10-28", "stay_2026-10-30", "pace_room_nights", 30, 20),
    row("2026-10-28", "stay_2026-10-27", "pace_room_nights", 9, 9),        // already past
  ];
  const v = paceView([...metrics, ...daily], "2026-10-28");
  assert.deepEqual(v.next_days.map((d) => [d.stay_date, d.room_nights, d.room_nights_ly]), [["2026-10-29", 60, 80], ["2026-10-30", 30, 20]]);
  assert.equal(Math.round(v.next_days[0].gap), -25);
  assert.ok(!v.platforms[0].months.some((m) => m.month.length > 7));
  const m = monitor({ metrics: [...metrics, ...daily], runs: [{ id: "20261028-102000", outcome: "done" }] }, new Date("2026-10-28T05:00:00Z"));
  assert.ok(!m.alerts.some((x) => /stay_2026-10-/.test(x.id)));
});
