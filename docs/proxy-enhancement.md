# 节点整合功能增强（开发文档）

目标：增强“订阅节点 → 可用代理池 → 并发采样 Enka”的链路，支持更多协议/内核，并且动态维护可用代理池，以达到并发数量需求（提升吞吐、降低 429/超时、减少人工干预）。

## 1. 背景与现状

当前项目已具备：

- **节点导入**：WebUI 支持导入订阅 URL/节点文本，落库到 `data/proxy.sqlite`（表 `proxy_node`）。
- **代理池启动**：启动时从订阅（或 DB fallback）解析节点，使用 **v2ray-core** 启动多个本地 HTTP 代理（如 `http://127.0.0.1:179xx`）。
- **测活逻辑**：对每个本地 HTTP 代理请求 `proxy.subscription.testUrl`（默认为 Enka API），要求 **JSON 且非 HTML** 才算可用。
- **采样并发**：采样阶段按“代理桶”节流（每个代理独立的 `delayMs`），并发 worker 在多个代理之间分摊请求。

但存在瓶颈：

- **协议/内核覆盖不足**：订阅中常见的 Hysteria2/TUIC/Reality 等节点，无法由 v2ray-core 启动或无法被解析，导致“明明客户端 tcpping 活跃很多节点，但本项目可用节点很少”。
- **测活标准与客户端不同**：tcpping 只验证 TCP 端口连通；本项目测活要求“能作为 HTTP 代理成功访问 Enka 并返回 JSON”，标准更严格，因此可用数更少是合理现象。
- **探测覆盖不足**：默认 `probeCount/probeRounds` 只探测订阅的一小部分候选节点，可能遗漏大量可用节点。
- **池是静态的**：`npm start` 启动时选出 N 个可用节点后就固定了；节点质量随时间变化时无法自动补齐目标并发。

## 2. 目标（对齐“并发数量需求”）

### 2.1 核心目标

- **协议支持扩展**：尽可能覆盖主流订阅生态，至少包含：
  - Clash / Mihomo / Sing-box 的 YAML（`proxies:` / `outbounds:` 等）
  - URI：`vmess://`、`vless://`、`trojan://`、`ss://`（已支持）
  - 额外：`hysteria2`、`tuic`、`ssr`（可选）、`vless+reality`（可选）
- **动态维护代理池**：池大小不是固定值，而是“按目标并发/吞吐动态扩容/淘汰”。
- **可靠性优先**：避免把 “能连上但会返回 HTML/WAF/频繁 429/超时” 的节点纳入池。

### 2.2 吞吐/并发的工程约束

项目扫描吞吐的核心近似：

- **有代理池**：吞吐 ≈ `usableNodes / delayMs`（每个代理桶独立节流）  
  建议保持：`samples.enka.concurrency <= proxy.subscription.maxNodes`，否则多个 worker 会抢同一代理桶而失去并发收益。
- **无代理**：走全局限速（SQLite rate limiter），吞吐上限 ≈ `1 / noProxyDelayMs`（跨进程/跨游戏共享）。

因此要达到更高吞吐，必须同时做到：

1) 可用节点更多（usableNodes↑）；2) 每节点节流更合理（delayMs↓）；3) 失败节点快速剔除（减少拖慢）。

## 3. 设计：统一节点模型 + 内核适配器 + 动态池管理

### 3.1 统一节点模型（Canonical Node）

将所有来源（订阅/粘贴文本/Clash YAML/DB）统一归一为同一个 node 结构，例如：

```js
{
  type: "vless" | "vmess" | "trojan" | "ss" | "hysteria2" | "tuic" | ...,
  tag: "display name",
  host: "example.com",
  port: 443,
  // 认证/加密字段（按协议）
  id, password, method, encryption, flow,
  // 传输/安全
  net: "tcp" | "ws" | "grpc" | ...,
  tls: "tls" | "reality" | "",
  sni, allowInsecure,
  wsHost, wsPath, grpcServiceName,
  // Reality/Hysteria2/TUIC 等扩展字段（如有）
  realityPublicKey, realityShortId, hy2Obfs, ...
}
```

并保证：

- `nodeKey()` 可稳定去重（当前实现为 `type|host|port|id/password/method`）。
- 解析失败不影响整体导入（best-effort）。

对应代码位置：

- 解析：`src/proxy/subscription.js`
- 去重：`src/proxy/subscription.js` 的 `nodeKey()` / `dedupeNodes()`
- DB 存储：`src/db/proxy.js`（表 `proxy_node`）

### 3.2 内核适配器（Core Adapters）

引入抽象接口，让“同一份 node”可以由不同内核实现启动：

```ts
interface ProxyCoreAdapter {
  id: "v2ray" | "xray" | "sing-box" | "mihomo";
  ensureCore(): Promise<void>;
  supports(node): boolean;
  start(node, localPort): Promise<{ proxyUrl, close() }>;
  version(): Promise<string>;
}
```

建议优先落地两个方向：

1) **mihomo / sing-box**：协议覆盖更广（Hysteria2/TUIC/Reality 等更可能支持），适合“节点多、协议杂”的订阅生态。  
2) **v2ray-core / xray**：兼容现有实现，作为保底路径。

> 目标不是“全内核都跑”，而是**自动选择**：`supports(node)` 优先匹配覆盖更好的内核。

### 3.3 测活策略（从 TCP 到可用性）

将测活拆为分层，避免“tcpping 活但 HTTP 代理不可用”的误判：

1) **启动成功**：内核能启动且端口监听成功。  
2) **HTTP 代理可用**：通过本地代理请求 `testUrl`，响应必须：
   - body 非 HTML（过滤 WAF/ban 页面）
   - body 是 JSON（或至少 JSON-like）
   - status 在允许集合（如 200/400/403/404/424）
3) **业务可用（可选）**：对 Enka 做轻量业务探测（例如返回结构有 `playerInfo`/`avatarInfoList` 等），用于过滤“能代理但访问不到目标域”的节点。

对应代码位置：

- 当前测活实现：`src/proxy/pool.js` 的 `testProxy()`

### 3.4 动态代理池（Pool Manager）

将“池”的目标从“启动时找 N 个”升级为“持续维护目标容量”：

- 输入：节点来源（订阅/DB）、目标池大小、测活策略、并发需求、失败阈值。
- 输出：稳定的 `PROXY_URLS`（或提供一个 `getProxyDispatcher()` 的运行时 API）。

核心能力：

- **补齐**：当可用节点数 < `targetSize`，自动从候选中继续探测并补齐。
- **淘汰**：当某节点在采样阶段连续出现传输失败/HTML/WAF 等，标记降权或移出池。
- **轮换**：按成功率、RTT、错误类型进行加权选择，避免长期卡在少数节点。
- **分区（可选）**：按地区/出口 IP / ASN 对节点分组，以便“多区域 CDN”策略。

持久化建议：

- 继续使用 `data/proxy.sqlite`，新增统计表（可选）：
  - `proxy_node_stat(node_key, ok_count, fail_count, last_ok_at, last_fail_at, avg_ms, last_error, disabled_until, ...)`
  - `proxy_pool_member(run_id, node_key, local_port, started_at, ...)`

这样 WebUI 可以展示：

- 当前候选总数 / 已测活数 / 可用数 / 目标数
- 失败原因分布（TLS/超时/HTML/WAF/429）

## 4. 配置与 WebUI（面向“只允许 npm start”）

### 4.1 最小化配置（建议）

对用户暴露的配置尽量少，但能满足核心需求：

- `proxy.enabled`：开关
- `proxy.required`：没有可用节点是否允许降级直连
- `proxy.subscription.maxNodes`：目标池大小（即 `targetSize`）
- `proxy.subscription.probeCount/probeRounds`：候选探测规模
- `proxy.subscription.testUrl/testTimeoutMs`：测活目标与超时

其他高级项（可放“高级设置”）：

- `pickStrategy`（first/spread）
- 启动并发 `startConcurrency`
- 失败阈值（禁用/降权策略）

### 4.2 建议增加的 API（给前端美化/运维）

在现有 `docs/webui-api.md` 基础上，可扩展：

- `GET /api/proxy/pool/status`：当前池状态（目标数/可用数/错误分布）
- `POST /api/proxy/pool/rebuild`：强制重建池（重新探测）
- `POST /api/proxy/probe`：对指定 node_key 或订阅进行一次探测（用于调试）

## 5. 迭代路线（建议）

### Phase 1：把“可用节点数”做大

- 提高探测覆盖：调大 `probeCount/probeRounds`，并把失败原因写入 DB（便于复盘）。
- 解析增强：补齐 Clash YAML 对 `hysteria2/tuic` 的解析（至少能落库）。
- 动态补齐：当池不足时继续从候选探测，直到达到 `maxNodes` 或候选耗尽。

### Phase 2：内核扩展（解锁 Hysteria2/TUIC/Reality）

- 引入 `mihomo` 或 `sing-box` adapter：
  - 自动下载/校验二进制（类似现有 `v2ray-core` 下载逻辑）
  - 按 node 生成最小运行配置
  - 暴露本地 HTTP 代理端口，保持与现有采样模块兼容

### Phase 3：运行期自适应（长期稳定吞吐）

- 在采样阶段记录每个代理桶的错误类型与延迟，实时调整选择权重。
- 对“返回 HTML/WAF”类型错误快速降权（避免拖慢整体吞吐）。
- 可选：分地区策略，用于拉取不同区域的 CDN 缓存数据。

## 6. 与现有代码的对接点（快速索引）

- 节点解析：`src/proxy/subscription.js`
- v2ray 配置构建：`src/proxy/v2ray.js`
- 代理池实现：`src/proxy/pool.js`
- 代理 DB：`src/db/proxy.js`
- 采样使用代理：`src/samples/collect.js`（通过 `PROXY_URLS`）
- WebUI 导入节点 API：`src/server.js` 的 `POST /api/proxy/import`

