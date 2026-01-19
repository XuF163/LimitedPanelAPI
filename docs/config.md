# 配置说明（LimitedPanelAPI）

配置文件位于 `config/` 目录：

- 默认配置：`config/defSet.yaml`（请勿直接修改）
- 用户配置：`config/config.yaml`（不存在时首次启动会自动从默认配置复制生成；也可参考 `config/config.example.yaml`）

建议仅使用 `npm start` 启动，并通过 `GET /ui`（WebUI）修改配置。

（仍保留少量环境变量覆盖能力用于调试，但不推荐作为常规使用方式。）

## HTTP 服务 & WebUI

配置项：

- `server.enabled`：是否启用 HTTP 服务
- `server.host`：监听地址（默认 `0.0.0.0`）
- `server.port`：端口（默认 `4567`）
- `server.ui.*`：WebUI 配置（见下）

接口（在线 JSON）：

- `GET /healthz`
- `GET /gs/hyperpanel`
- `GET /sr/hyperpanel`
- `GET /zzz/hyperpanel`
- `GET /presets/<game>/<uid>.json`

WebUI：

- `GET /ui`：配置页面（默认展示“简洁配置”，保存后会生成精简版 `config/config.yaml`）
- `GET /api/config?kind=user|default`
- `PUT /api/config?kind=user`：写入 `config/config.yaml`（写入前会校验 YAML）
- `GET /api/config-json?kind=user|default|merged`：获取解析后的 JSON（WebUI 用）
- `PUT /api/config-simple?mode=replace|merge`：用“简洁配置”保存（replace=精简覆盖；merge=尽量保留高级项）
- `POST /api/meta/sync?game=gs|sr|all`：同步 meta（WebUI 按钮）

WebUI 安全建议（强烈推荐）：

- 默认 **仅允许本机访问**（`server.ui.allowRemote: false`）
- 如需远程访问：
  - 开启 `server.ui.allowRemote: true`
  - 设置 `server.ui.token`（或环境变量 `UI_TOKEN`）
  - 请求需携带 `x-ui-token` 头或 `?token=...` 参数

## Meta（GS/SR）

本项目会把 GS/SR 的 meta 统一落到：

- `resources/meta-gs`
- `resources/meta-sr`

配置项：

- `meta.autoSync`：启动时自动确保 meta 存在（缺失时会拉取）
- `meta.autoUpdate.enabled`：后台定期更新（相当于“每天 pull 一次”）
- `meta.autoUpdate.intervalSec`：更新间隔（秒），默认 `86400`

### Meta 源选择（cnb / miao-plugin）

配置项：`meta.source.type`

1) `cnb`（默认）
- 从 CNB 的 `qsyhh_res/meta` 拉取（`meta-gs` / `meta-sr` 分支）

2) `miao-plugin`
- 从你本地的（或自动 clone 的）`miao-plugin` 仓库里拷贝：
  - `<miao-plugin>/resources/meta-gs`
  - `<miao-plugin>/resources/meta-sr`
> 当 `miaoPlugin.dir` 为空时，会优先尝试使用 `<YunzaiRoot>/plugins/miao-plugin`；否则按 `miaoPlugin.git` 自动 clone。

示例（使用 CNB）：

```yaml
meta:
  source:
    type: cnb
    cnb:
      repo: https://cnb.cool/qsyhh_res/meta.git
      branch:
        gs: meta-gs
        sr: meta-sr
```

示例（使用 miao-plugin，本地已 clone）：

```yaml
meta:
  source:
    type: miao-plugin
    miaoPlugin:
      dir: "D:/repos/miao-plugin"
```

示例（使用 miao-plugin，自动 clone 到本项目 resources 下）：

```yaml
meta:
  source:
    type: miao-plugin
    miaoPlugin:
      dir: ""
      git:
        repo: https://github.com/yoimiya-kokomi/miao-plugin.git
        ref: master
        dir: ./resources/miao-plugin
```

切换 meta 来源后：

- 推荐在 `GET /ui` 点击“同步 meta”
- 或直接重启 `npm start`（本项目会根据 `.meta-source.json` 自动判断并重拉）

## 采样数据源（samples）

配置项：

- `samples.mode: playerdata`：从本地 Yunzai 的 `data/PlayerData/<game>` 采样（当前仅 `gs/sr` 支持）
- `samples.mode: enka`：从 Enka 接口采样（`gs/sr/zzz` 支持）

说明：`npm start` 会同时处理 `gs/sr/zzz`。其中 `samples.mode` 主要影响 `gs/sr`；`zzz` 永远走 Enka（UID 为 8 位，未配置 UID 列表/范围时会跳过 zzz 扫描）。
- `samples.alwaysSample`：启动时是否总是进行采样

### PlayerData 采样

- `samples.playerdata.dir`：为空则自动使用 `<YunzaiRoot>/data/PlayerData/<game>`
- `samples.playerdata.maxFiles`：限制扫描文件数，`0` 表示不限制

### Enka 采样

配置项（`samples.enka`）：

- `<game>.uidStart` / `<game>.uidEnd`：UID 范围（`game` 为 `gs/sr/zzz`；ZZZ 为 8 位）
- `<game>.uids`：显式 UID 列表（优先级高于范围）
- 未配置某个游戏的 UID 列表/范围时：启动只会输出 `skipped game=<game>`，不会去请求 Enka
- WebUI 即使在 `samples.mode: playerdata` 也允许填写并保存这些范围（用于预配置）；但 `gs/sr` 只有切到 `enka` 才会生效
- `maxCount`：每次启动最多扫多少 UID（避免一次扫太大）
- `concurrency`：并发 worker 数
- `delayMs`：有代理时按“代理数量分桶节流”的每桶间隔（毫秒）
- `noProxyDelayMs`：无代理/无可用节点时的 **全局限速**（跨 gs/sr/zzz、跨进程共享；毫秒）
- `timeoutMs`：单次请求超时（毫秒）
- `retryFirst`：每次启动优先重试的 UID 数（来自 SQLite 的失败队列）
- `storeRawDb`：是否把 raw 响应（gzip）写入 SQLite（推荐开）
- `saveRawFile`：是否额外写 `data/raw/<game>/<uid>.json`（大规模扫描不推荐）
- `circuitBreaker.*`：简易熔断策略

定期重扫（刷新样本）：

- `samples.enka.rescan.enabled`
- `samples.enka.rescan.afterSec`：认为“过期”的最小间隔（秒）
- `samples.enka.rescan.first`：每次启动优先重扫多少个 UID（按 `last_checked_at` 最旧优先）

## 极限面板（preset）

配置项：

- `preset.uid`：输出 UID（`gs/sr` 默认 `100000000`；`zzz` 默认 `10000000`）
- `preset.name`
- `preset.alwaysGenerate`：启动时是否总是重新生成
- `preset.limitChars`：限制角色数量（0=不限制）

周期性刷新（采样 + 生成）：

- `preset.autoRefresh.enabled`
- `preset.autoRefresh.intervalSec`
- `preset.autoRefresh.runOnStart`
- `preset.autoRefresh.force`：忽略 `samples.alwaysSample` / `preset.alwaysGenerate`

## ZZZ 源数据

ZZZ 的面板转换/评分/专武识别依赖 `ZZZ-Plugin` 资源（如 `model/Enka/formater.js`、`resources/map/*.json` 等）。

配置项：

- `zzz.source.type`：
  - `yunzai-plugin`：使用本地 `Yunzai/plugins/ZZZ-Plugin`（最稳）
  - `github`：从 GitHub 拉取 `ZZZure/ZZZ-Plugin` 到 `resources/zzz-plugin`
- `zzz.source.pluginDir`：当 `type=yunzai-plugin` 时生效
- `zzz.source.github.*`：当 `type=github` 时生效

## 代理（v2ray-core，可选）

开启后会自动：

1) 下载 v2ray-core
2) 解析订阅（支持 base64/vmess/vless/trojan/ss 以及 Clash YAML 的 `proxies:`）
3) 探测节点可用性
4) 启动多个本地 HTTP 代理作为“代理池”，供 Enka 采样使用

关键配置项：

- `proxy.enabled`
- `proxy.required`
- `proxy.db.path`：代理节点启动/测活记录 SQLite（默认 `data/proxy.sqlite`）
- `proxy.v2ray.keepConfigFiles`：是否保留 v2ray 配置文件到项目目录
- `proxy.subscription.urls`
- `proxy.subscription.maxNodes`
- `proxy.subscription.probeCount`
- `proxy.subscription.testUrl`：建议使用返回 JSON 的 API 地址（403/404 也算“可连通”）

## QA / 开发调试

默认只需要 `npm start` + `GET /ui` 配置即可。
