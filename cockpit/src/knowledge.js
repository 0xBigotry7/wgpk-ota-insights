// OTA operating knowledge the copilot, the daily report and the alert playbook work from. Collected 2026-10-23 from
// platform partner guides and industry write-ups (sources at the end) plus the hotel KB. Rules of thumb, not platform
// guarantees: platforms do not publish ranking weights.
//
// ota/advise.py reads the KNOWLEDGE text out of this file, so keep it a single String.raw template.

export const KNOWLEDGE = String.raw`
# 酒店基本盘
- Wyndham Garden Phuket Kamala，2025 年开业，约 420 间可售。中端，家庭和情侣度假为主，可接小团。
- 产品短板：山坡地形，离海滩约 800 米，周边商店少；只有一个约 100 座的全日餐厅，旺季早餐压力大；会议室约 100 平米。
- Kamala 竞品：Novotel Kamala、Namaka、Marin，新开的 Twinpalms、Mövenpick 一带。2026 年普吉新增约 2,900 间供应，偏高端。
- 客源：俄罗斯（旺季主力）、印度、中国（暑期家庭是 2027 年的重点）、英国、澳洲、中东、欧美；拉美团支撑淡季。
- 价格和房态由 OPERA → SynXis（渠道经理）同步到各 OTA。调价、开关房、最少入住天数都在 OPERA / SynXis 做，不在 OTA 后台单独改。

# 普吉季节（2025 年全岛入住率 76%，ADR 约 5,800 THB）
- 旺季 11 月–4 月，1 月最高（约 92%），圣诞新年和春节是高峰。淡季 6–9 月。10 月是旺季前的爬坡期。
- 2026 年判断：靠价格而不是靠入住率增长，ADR 比入住率更守得住。新供应会压淡季和中高端价格。
- 旺季前 4–8 周：锁定 12 月 20 日–1 月 5 日、春节的价格梯度和最少入住天数，不要把高需求日期放进深度折扣。

# Booking.com
- 官方说法：可售是排名第一因素，至少放开未来 12 个月；最少入住天数、不可到店（CTA）等限制会降低曝光。算法以转化为目标，价格竞争力、灵活取消和点评分都计入。
- 其他排名信号：点评分（近期点评权重更高；低于 7 分明显被压，8 分以上曝光稳定，9 分以上是强信号）；房源页完整度；无效取消（酒店原因取消）扣分；回复速度。
- Genius：一级 10%（必须覆盖最便宜和最受欢迎的房型）、二级 15%、三级 20%；需点评分 ≥7.5 且至少 3 条点评；会和其他优惠叠加。
- Preferred：目的地前 30%，绩效分 ≥70%、点评分 ≥7、外部价格有竞争力，每 90 天复核；Preferred Plus：前 10%、绩效分 ≥80%、点评分 ≥8。佣金约高 3 个点（第三方说法）。
- Visibility Booster：对选定入住日期（可按国家）加佣换曝光，只用在慢日期。
- 折扣叠加（以后台为准）：移动价可叠加 Genius 和基础优惠，但不叠加国家价、Getaway、Late Escape、黑五；国家价叠加 Genius 不叠加移动价；Late Escape 至少 15%；黑五不叠加任何优惠。
  多个折扣叠加后最终价可能比预期低很多，必须看叠加后的成交价。我们的 Booking 销售数据里 Flash Sale（SBKFS）是多个房型最大的单一价型，ADR 约 3,400–3,900 THB。
- 漏斗：搜索曝光 → 房源页访问（点击率）→ 预订（转化率）。点击率低先看首图、列表价、评分和标签；转化率低看房型照片、价格、取消政策、早餐和房型说明。
- 后台 Analytics → Visibility Dashboard 有取消率（近 90 天，对比市场）、价格质量分、房源页分、点评分对比同类，目前采集还没接这一页。
- 排名变化一般 2–4 周才反映，点评分变化更慢。

# Agoda
- 排名看：内容分（满分 100，Partner Portal → Performance → Analytics → Content Score：房型描述、设施、照片、政策）；价格一致（比官网或别家贵会被压）；
  转化率；可售（满房或断档的日历排名低，旺季也留少量房）；点评分（1–10）和对差评的回复；房价房态同步准确。
- AGP（官方）：每单加佣，Basic +10%、Standard +12%（另送置顶 7 折）、Premium +15%（另送 AGX 额度），至少 90 天，换 Preferred 标和排名加权。
- AGX：按日期、客源国、提前期加佣换曝光，带 Boosted 标。付费置顶：城市或区域前 3 / 前 15。促销：早鸟、尾房、会员价。

# Expedia
- Partner Central → Visibility Performance 有两个分：Offer Strength（按重要性：可售、价格竞争力、内容、照片）和
  Guest Experience（按重要性：可避免的换酒店、房况、可避免的取消、清洁、入住、退款、设施、员工）。两个分都到 85 以上才能进 VIP Access（免费）。
- Content Score 有四块：酒店设施、客房设施、政策和押金、照片。政策字段空着会掉出筛选结果。点评数量和新鲜度也算（量多的 4.3 可能排在量少的 4.6 前面）。
- 付费：Accelerator（按日期加佣，住完才付，适合低入住日期）；TravelAds（按点击付费置顶，适合旺季守位）。
  酒店 2026 年在投 Expedia Media Solutions（全年三期）和 TravelAds，要看效果报表判断值不值。

# 携程 / 去哪儿 / 同程
- 点评分按近三年有效点评、按新鲜度和可信度加权；4.7 分以上有“超棒”标签（携程中文站 5 分制；eBooking 后台和 Trip.com 国际站按 10 分制显示，约等于 9.4 分）。同程会接入携程点评。
- 服务质量分和排序看：订单确认速度、拒单和到店无房、价格一致、点评分和点评回复、问答回复、房源信息完整度。
  拒单、满房后才关房、到店无房扣分最重。
- 挂牌（金牌、特牌等）和推广（如“携程推广”）换曝光；中国暑期家庭市场要提前 2–3 个月备好亲子房型、接送和中文服务卖点。

# 收益管理日常
- 指数：MPI = 我们入住率 ÷ 竞品入住率 × 100；ARI = 我们 ADR ÷ 竞品 ADR × 100；RGI = MPI × ARI ÷ 100。三个一起看：MPI 高、ARI 低就是价格定低了。
  用 Booking 本月数据近似：间夜 950 对同类 747（约 127），ADR 5,814 对 7,373（约 79）。这是近似值，不是 STR 指数。
- 每天：看昨天净新增（新订减取消）和未来 90 天在手（OTB）对比去年同期同提前期和预算（pace）；看竞品价格；看各渠道价格是否一致；
  看关房日期和限制；高需求日期（周中订单涌入、节假日）提价，落后日期短期促销而不是全线降价。
- 提前期：远期不要先降价，降价留给临近日期。提前卖光说明价格定低了，目标是最后几间房在入住当天卖掉。
  Booking 中位提前期约 21 天、Agoda 约 14 天；被取消的 Booking 订单平均提前约 69 天预订，正常入住的约 27 天。
- 取消：亚太酒店平均约 13–14%，Booking 约四分之一被取消，OTA 约 22% 对直订约 11%。远期用不可退款或预付价型、缩短免费取消期。
  关注净预订（扣取消）和扣佣金后的净 ADR，而不是毛预订。
- 渠道结构：比较各 OTA 的佣金、取消率和净 ADR，把旺季房量往净收入高的渠道倾斜；淡季用 OTA 项目（AGX、Accelerator、Genius、Visibility Booster）补量。
- 平台没有公开的点击率和转化率行业基准，用后台给的同类值和我们自己的走势判断。

# 调查假设（不是已证实因果；当前后台政策与数据优先）
- 曝光比同类少：可售房少或日期断档 → 开放更多日期和房型；价格比竞品高 → 复核 BAR；没参加可见度项目 → 评估 Genius / Preferred / AGX / Accelerator。
- 曝光够但点击率低：首图不吸引、价格看起来贵、评分低 → 换首图（泳池、海景、家庭场景），检查列表页最终价和标签。
- 点击够但转化低：房型照片和说明不清、取消政策严、价格比别家贵、没早餐选项 → 补房型照片和说明，加含早和可取消价型，查价格一致。
- 间夜比同类多但均价比同类低很多：是价量结构差异，不足以证明低价换量或收入损失 → 先核对入住日、房型、客源、折扣叠加与净佣金，收益经理再决定是否调价。
- 取消率高：远期免费取消太宽 → 远期日期加不可退款 / 预付价型，看净预订和按提前期的取消率。
- 可售率低或排名突然掉：查关房日期、最少入住天数、停售是否和 PMS 一致，查项目资格（Genius 等级、Preferred、VIP Access）。
- 点评分下降或某项问题率高：找差评共同主题 → 派给对应部门整改，一周后看新点评。
- 会员占比低：前台入住时邀请入会，官网和前台突出会员价，降低 OTA 依赖。

# 例行检查
- 每天（收益/销售）：昨日新增和取消、未来 14 天和 90 天在手、竞品价、渠道价差、各平台是否能登录、尾房和高需求日期调整。
- 每天（前台）：携程问答、OTA 客人消息、当天入住特殊要求、到店无房风险。
- 每周：漏斗（曝光、点击率、转化）对比同类；内容分和缺项；促销和项目效果（Genius、AGX、Accelerator、TravelAds）；差评主题派单。
- 每月：渠道结构和扣佣后的净 ADR；取消率；预算差距；下月和下季度价格日历；付费推广回报。

# 来源
Booking 排名与项目：smartorder.ai/booking-com-ranking-algorithm、genius-discounts-vs-partner-programs；Agoda：smartorder.ai/how-to-increase-visibility-on-agoda、partnerhub.agoda.com/how-to-improve-your-content-score；
Expedia：smartorder.ai/expedia-ranking-tips-for-hotels；携程点评规则：vocust.com/school/insightcase/352、424；取消：hoteltechreport.com（Bookassist 调查）；
Pickup / pace：hospitalitynet.org/news/4124797；Booking 官方帮助（排名基础、Visibility Dashboard、排名看板）；Agoda AGP（partnerhub.agoda.com）；
Expedia 可见度指南（partner.expediagroup.com）；取消基准：D-Edge、Cloudbeds；普吉市场：Knight Frank Bangkok & Phuket Hotel Market 2H 2025；酒店资料：wgpk-shared-kb。
`;

// Phuket season for a month (1–12): what the period means for pricing.
export function season(month) {
  if (month === 10) return { name: "旺季前爬坡", tip: "锁定 12 月下旬到 1 月初和春节的价格梯度与最少入住天数，高需求日期不进深度折扣" };
  if (month >= 11 || month <= 4) return { name: month === 1 ? "旺季高峰" : "旺季", tip: "以价格为主：高需求日期提价，留少量房给临近日期，降价只做临近尾房" };
  if (month === 5) return { name: "旺转淡", tip: "提前布局淡季：中国暑期家庭、拉美团和 OTA 项目（AGX / Accelerator / Genius）补量" };
  return { name: "淡季", tip: "保量为主但守住底价：针对客源国的促销、长住优惠、AGX / Accelerator 只投低入住日期" };
}

// What each number means and what good looks like, keyed by metric name pattern. First match wins.
export const GLOSSARY = [
  [/^search_views$/, "在搜索结果里被看到的次数。比同类少，先看可售房、价格和可见度项目"],
  [/click_rate/, "看到我们的人里点进房源页的比例。主要受首图、列表价和评分影响"],
  [/book_rate|conversion/, "进房源页的人里下单的比例。主要受价格、房型照片、取消政策影响"],
  [/^adr|_adr|adr_/, "平均每间夜房价。对比必须确认日期、房型和收入范围一致；低价高量不自动证明因果"],
  [/room_nights/, "卖出的间夜数"],
  [/revenue/, "房费收入（平台口径，含佣金前）"],
  [/review_score|rating/, "平台点评分。Booking 8 分以上曝光稳定，携程 4.7 / 5（约 9.4 / 10）以上有“超棒”标签"],
  [/nps/, "净推荐值：推荐者占比减贬损者占比。温德姆品牌问卷口径"],
  [/osat/, "整体满意度（满分 10），温德姆品牌问卷"],
  [/^problem_|had_problem|problem_incidence/, "住店期间遇到该问题的客人占比，越低越好"],
  [/page_score/, "房源页完整度，100% 为满分，缺项会影响排名"],
  [/availability_for_search/, "可被搜索到的日期比例，越高曝光机会越多"],
  [/views_rank|popularity_rank/, "在竞品组或区域里的排名，越小越好"],
  [/pace_/, "近 30 / 90 天新增的未来订单，反映订单进来的速度"],
  [/rewards/, "温德姆会员相关比例，会员多则 OTA 依赖低"],
  [/rapid_response|mgmt_response/, "点评回复的速度和覆盖率"],
];

export function explain(metric) {
  const hit = GLOSSARY.find(([re]) => re.test(metric));
  return hit ? hit[1] : "";
}

// Recurring checks by cadence. id is stable: the cockpit stores ticks by id and period.
export const ROUTINES = {
  daily: [
    { id: "d-pickup", owner: "收益/销售", text: "看昨天新增和取消、未来 14 天和 90 天在手，对比去年同期和预算" },
    { id: "d-rates", owner: "收益/销售", text: "看竞品价格和各渠道价差（Booking / Agoda / Expedia / 携程 / 官网），高需求日期提价" },
    { id: "d-login", owner: "收益/销售", text: "驾驶舱“平台连接状态”全绿；有未登录的当天处理" },
    { id: "d-qa", owner: "前台", text: "回复携程问答和各 OTA 客人消息" },
    { id: "d-arrivals", owner: "前台", text: "核对当天 OTA 到店名单和特殊要求，排查到店无房风险" },
  ],
  weekly: [
    { id: "w-funnel", owner: "收益/销售", text: "对比同类看漏斗：曝光、点击率、转化率，找最弱的一环" },
    { id: "w-content", owner: "市场/内容", text: "检查各平台内容分和缺项，更新首图和房型照片" },
    { id: "w-promo", owner: "收益/销售", text: "复盘促销和付费项目效果（Genius、AGX、Accelerator、TravelAds），停掉没效果的" },
    { id: "w-reviews", owner: "总经理", text: "看本周差评主题，派给对应部门，跟进上周整改" },
  ],
  monthly: [
    { id: "m-mix", owner: "收益/销售", text: "渠道结构、扣佣后的净 ADR 和取消率，决定下月各渠道房量" },
    { id: "m-budget", owner: "总经理", text: "对比预算差距，定下月和下季度价格日历" },
    { id: "m-media", owner: "市场/内容", text: "核对 Expedia Media Solutions、TravelAds 等付费推广的效果报表" },
  ],
};

export function periodKey(cadence, date = new Date()) {
  const bkk = new Date(date.getTime() + 7 * 3600e3);
  const day = bkk.toISOString().slice(0, 10);
  if (cadence === "daily") return day;
  if (cadence === "monthly") return day.slice(0, 7);
  // ISO week, e.g. 2026-W43
  const d = new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - y0) / 864e5 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
