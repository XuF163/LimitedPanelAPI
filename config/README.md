# LimitedPanelAPI 配置说明

本目录用于存放 LimitedPanelAPI 的配置文件：
- 默认配置：`config/defSet.yaml`（请勿直接修改，更新时可能被覆盖）
- 用户配置：`config/config.yaml`（不存在时，首次启动会自动从默认配置复制生成；也可参考 `config/config.example.yaml`）

## HTTP 服务（托管极限面板 JSON）

配置项：
- `server.enabled`: 是否启动 HTTP 服务
- `server.host`: 监听地址（默认 `0.0.0.0`）
- `server.port`: 端口（默认 `4567`）

接口：
- `GET /healthz`: 健康检查
- `GET /gs/hyperpanel`: 原神极限面板（默认 UID：`preset.uid`，通常为 `100000000`）
- `GET /sr/hyperpanel`: 崩铁极限面板（默认 UID：`preset.uid`，通常为 `100000000`）
- `GET /zzz/hyperpanel`: 绝区零极限面板（默认 UID：`qa.uidZzz`，通常为 `10000000`）
- `GET /presets/<game>/<uid>.json`: 精确指定游戏与 UID（兼容旧路径）

## 数据源选择（采样来源）

在 `config/config.yaml` 中设置：

- `samples.mode: playerdata`：从本地 Yunzai 缓存的 `data/PlayerData/<game>` 采样
- `samples.mode: enka`：从 Enka 接口按 UID 列表/UID 范围采样（注意：范围会被 `maxCount` 截断，避免一次扫描过大）

环境变量也可覆盖配置（例如：`SAMPLE_MODE`、`PLAYERDATA_DIR`、`ENKA_UIDS`、`ENKA_UID_START` 等）。

## 存储（SQLite）

Enka 扫描状态与（可选）原始响应默认写入 `data/scan.sqlite`（仓库已忽略 `data/`）：
- `samples.enka.storeRawDb`：是否把 raw 响应（gzip）写入 SQLite（大规模扫描建议开启）
- `samples.enka.saveRawFile`：是否额外写 `data/raw/<game>/<uid>.json`（大规模扫描不建议）
- `samples.enka.retryFirst`：每次启动优先重试的 UID 数（来自 SQLite 的失败队列）
- `samples.enka.circuitBreaker.*`：简易熔断（避免上游整体不可用时浪费时间）

注意：`scripts/qa-flow.js` 默认使用 `qa.scan.dbPath`（默认 `data/scan.qa.sqlite`）并在每次运行前重置，避免生成大量 `scan.qa.*.sqlite` 测试库文件。

## ZZZ 源数据

ZZZ 的面板转换/评分依赖 `ZZZ-Plugin` 的资源（如 `resources/map/*.json` 以及 `model/Enka/formater.js`）。

配置项：
- `zzz.source.type`：
  - `yunzai-plugin`：使用本地 `Yunzai/plugins/ZZZ-Plugin`（默认）
  - `github`：从 GitHub 拉取 `ZZZure/ZZZ-Plugin` 到 `temp/LimitedPanelAPI/resources/zzz-plugin` 并使用
- `zzz.source.pluginDir`：当 `type=yunzai-plugin` 时，可自定义插件目录（留空自动使用默认路径）
- `zzz.source.github.*`：当 `type=github` 时，配置仓库/分支/拉取目录与自动更新

## 代理（v2ray-core，可选）

开启后会自动：
1) 下载 v2ray-core
2) 解析订阅（支持：base64/vmess/vless/trojan/ss、以及 Clash YAML 的 `proxies:`）
3) 探测节点可用性
4) 启动多个本地 HTTP 代理作为“代理池”，供 Enka 采样使用（并发时按代理数量分桶限速）

配置项：
- `proxy.enabled`: 是否启用
- `proxy.required`: 启用但无可用节点时是否直接报错退出
- `proxy.db.path`: 代理节点启动/测活记录数据库路径（默认：`data/proxy.sqlite`）
- `proxy.v2ray.keepConfigFiles`: 是否保留 v2ray 配置文件到项目目录（默认 false，写到系统临时目录以避免大量 json）
- `proxy.subscription.urls`: 订阅链接列表
- `proxy.subscription.maxNodes`: 代理池大小（默认 3）
- `proxy.subscription.probeCount`: 探测节点上限（默认 20）

环境变量快捷覆盖：
- `PROXY_ENABLED=1`
- `PROXY_DB_PATH=./data/proxy.sqlite`
- `PROXY_KEEP_CONFIG_FILES=1`
- `PROXY_SUB_URLS="https://example.com/sub1,https://example.com/sub2"`

## QA 流程（代理池 + 扫描 + 对比梁氏预设）

推荐直接跑脚本：`scripts/qa-flow.js`，会自动：
1) 用订阅启动代理池（v2ray-core）并测活，坏节点自动丢弃
2) 扫描 Enka UID（GS/SR 可分别配置）生成样本
3) 生成 `out/<game>/100000000.json` 极限面板
4) 与 `plugins/liangshi-calc/replace/data/<panelmodel>/PlayerData/<game>/100000000.json` 对比并输出报告

### 用配置文件（推荐）

把参数写进 `config/config.yaml` 的 `proxy.*` 与 `qa.*` 段（可参考 `config/config.example.yaml`），然后直接运行：

```powershell
cd temp/LimitedPanelAPI
node scripts/qa-flow.js
```

### 用环境变量（临时覆盖）

PowerShell 示例（按需调整参数）：
```powershell
cd temp/LimitedPanelAPI
$env:SUB_URL='https://zh.jikun.fun/share/col/江江公益?token=xxx'
$env:GAMES='gs,sr'

# 代理池
$env:PROXY_POOL_SIZE='20'
$env:PROXY_PROBE_COUNT='500'
$env:PROXY_START_CONCURRENCY='10'

# Enka 请求节奏（按代理数量分桶节流）
$env:DELAY_MS='3000'
$env:ENKA_TIMEOUT_MS='15000'
$env:CONCURRENCY='20'

# 扫描规模
$env:MAX_UIDS_GS='2000'
$env:MAX_UIDS_SR='2000'
$env:BATCH_SIZE='2000'

# 对比阈值（可按需要调）
$env:TOLERANCE_GS='5'
$env:TOLERANCE_SR='500'
$env:PASS_RATE_GS='0.8'
$env:PASS_RATE_SR='0.5'

node scripts/qa-flow.js
```

输出：
- 极限面板：`out/gs/100000000.json`、`out/sr/100000000.json`
- QA 报告：`out/qa-flow.<timestamp>.json`
