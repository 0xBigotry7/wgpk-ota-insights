# 酒店资料（只读）

OTA 运营知识（排名因素、计划门槛、症状→原因→行动、日常例行）用 ota-api GET /api/agent/knowledge。
这里是 OTA 相关的酒店资料，每天 06:30 从酒店知识库自动同步，别改。卖点和房型以这里为准。

- hotel/concierge/：给客人看的酒店事实（HOTEL_FACTS、ROOMS 房型、FACILITIES 设施、DINING 餐饮、POLICIES 政策、
  LOCAL_GUIDE 周边、WGPK_CLUB 会员、AIRPORT_TRANSFER 接送机、GUEST_QA 常见问题、LAUNDRY、SPRING_MENU、Tour Desk 价目）
- hotel/rooms/：房型说明、景观、泳池直通房使用
- hotel/brand/：官网文案、Wyndham 市场细分与代码、B2B 批发计划
- hotel/partners/：Expedia 媒体投放、Hotelbeds 分销、IDeaS 与 OPERA 对接状态、2027 夏季套餐
- hotel/policies/：点评回复标准、数据分类（哪些能对外说）

对外口径按 policies/DATA_CLASSIFICATION.md：客房总数说 432 间，不提房型代码、业主房、经营房量。
没有的资料（账号密码、业主信息、预算合同、财务）不在这里，也不要去找。
