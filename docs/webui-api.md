# WebUI API 定义（LimitedPanelAPI）

本文档用于前端开发/美化 WebUI 时对接后端接口（同源调用即可）。

## 约定

- 默认服务地址：`http://127.0.0.1:4567`
- 所有 API 返回 `application/json; charset=utf-8`
- 失败时通常返回：`{ "error": "<code>", "message": "<optional>" }`

## WebUI 鉴权/访问控制

WebUI 与其 API 都会走同一套校验（后端函数 `authUi()`）：

- `server.ui.enabled=false`：直接 404（`error=ui_disabled`）
- 默认仅允许本机访问：
  - `server.ui.allowRemote=false` 且请求来源不是 loopback（`127.0.0.1/::1`）→ 403（`error=ui_loopback_only`）
- 可选 Token：
  - 当 `server.ui.token`（或环境变量 `UI_TOKEN`）不为空时，必须携带 token，否则 401（`error=ui_token_required`）
  - token 传递方式二选一：
    - Header：`x-ui-token: <token>`
    - Query：`/ui?token=<token>`、或请求 API 时 `?token=<token>`（前端也可统一用 header）

## 页面

### GET `/ui`

返回 WebUI HTML 页面。

## 健康检查（非 WebUI 专用）

### GET `/healthz`

响应：

```json
{ "ok": true }
```

## 配置相关

### GET `/api/config?kind=user|default`

用途：读取原始 YAML 文本（用于“高级 YAML 编辑”）。

Query：
- `kind`：
  - `user`：用户配置（`config/config.yaml`）
  - `default`：默认配置（`config/defSet.yaml`）

响应：

```json
{ "kind": "user", "file": "C:\\...\\config\\config.yaml", "yaml": "..." }
```

### PUT `/api/config?kind=user`

用途：写入用户配置（`config/config.yaml`）。会先校验 YAML 可解析且根节点为 object/mapping。

说明：
- `kind` 参数仅用于前端显示；后端写入目标固定是用户配置文件。

Body（二选一）：
- `Content-Type: application/json`
  - `{ "yaml": "<yaml text>" }`（也兼容 `{ "text": "<yaml text>" }`）
- 或直接发送纯文本 YAML（不推荐，WebUI 默认用 JSON）

成功响应：

```json
{ "ok": true, "file": "C:\\...\\config\\config.yaml" }
```

常见错误：
- 400 `invalid_yaml`
- 400 `invalid_yaml_root`
- 500 `write_failed`

### GET `/api/config-json?kind=merged|user|default`

用途：读取解析后的 JSON（WebUI“简洁配置”加载时使用）。

Query：
- `kind`：
  - `merged`：默认配置 + 用户配置合并后的最终配置（推荐用于 UI 渲染）
  - `user`：仅用户配置解析后的 JSON
  - `default`：仅默认配置解析后的 JSON

响应：

```json
{ "kind": "merged", "file": "C:\\...\\config\\config.yaml", "json": { } }
```

### PUT `/api/config-simple?mode=replace|merge`

用途：用“简洁配置”保存（会生成精简版 `config/config.yaml`，适合减少配置项）。

Query：
- `mode`：
  - `replace`：用精简结构覆盖写入
  - `merge`：把精简结构 merge 到现有用户配置里（尽量保留高级项）

Body：JSON（建议按 WebUI 当前实现发送，字段均可选；后端会做 normalize）

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 4567,
    "enabled": true,
    "ui": { "allowRemote": false, "token": "" }
  },
  "meta": { "source": { "type": "cnb", "miaoPlugin": { "dir": "" } } },
  "samples": {
    "mode": "playerdata",
    "playerdata": { "dir": "" },
    "enka": {
      "gs": { "uids": [], "uidStart": 100000001, "uidEnd": 242422996 },
      "sr": { "uids": [], "uidStart": 100000001, "uidEnd": 242422996 },
      "zzz": { "uids": [], "uidStart": 10000000, "uidEnd": 99999999 },
      "maxCount": 20,
      "fetcher": "auto",
      "concurrency": 1
    }
  },
  "preset": { "uid": "100000000", "name": "极限面板" },
  "zzz": { "source": { "type": "yunzai-plugin", "pluginDir": "" } },
  "proxy": { "enabled": false }
}
```

说明：
- ZZZ 的 Enka UID 必须是 8 位（`10000000` ~ `99999999`），否则保存会报错
- `replace/merge` 都会用 `yaml.dump()` 生成 YAML：**会丢失注释/格式**
- 想保留手写 YAML 格式，请用 `/api/config` 写入原始文本

成功响应：

```json
{ "ok": true, "file": "C:\\...\\config\\config.yaml", "mode": "replace" }
```

常见错误：
- 400 `save_failed`

## Meta 同步

### POST `/api/meta/sync?game=gs|sr|all`

用途：WebUI “同步 meta”按钮。

Query：
- `game`：`gs` / `sr` / `all`

成功响应：

```json
{ "ok": true, "game": "all" }
```

常见错误：
- 400 `invalid_game`
- 409 `meta_sync_in_progress`
- 500 `meta_sync_failed`

### GET `/api/meta/info`

用途：查看 meta 来源/更新时间（读取 `resources/meta-*/.meta-source.json`）。

响应：

```json
{
  "ok": true,
  "syncing": false,
  "gs": { "root": "C:\\...\\resources\\meta-gs", "marker": { } },
  "sr": { "root": "C:\\...\\resources\\meta-sr", "marker": { } }
}
```

`marker` 可能为 `null`（文件不存在或解析失败）。

## 采样终止线（每日）

### GET `/api/samples/gate?game=gs|sr|zzz|all`

用途：查看当日扫描终止线状态（读取 `data/scan.sqlite` 的 `scan_daily_gate` 表），便于 WebUI 展示“缺哪些角色/差多少分”。

响应示例：

```json
{
  "ok": true,
  "day": "2026-01-20",
  "gates": {
    "gs": { "done": false, "totalChars": 100, "qualifiedChars": 40, "detail": {} },
    "sr": null,
    "zzz": null
  }
}
```

## 代理节点 / 订阅导入（WebUI 面板）

### GET `/api/proxy/nodes/summary`

用途：WebUI 显示当前已入库节点数。

响应：

```json
{ "ok": true, "count": 123, "dbPath": "C:\\...\\data\\proxy.sqlite" }
```

### POST `/api/proxy/import`

用途：导入订阅链接/节点文本到 SQLite（`proxy_node` 表）。**返回结果只展示本次新增节点**。

Body（`Content-Type: application/json`）：

```json
{
  "subscriptionUrls": ["https://example.com/sub.txt"],
  "rawText": "vmess://...\n...（也可粘贴 Clash YAML / base64 / vless:// / trojan:// / ss://）",
  "saveUrlsToConfig": true
}
```

字段说明：
- `subscriptionUrls`：订阅 URL 列表（可空）
- `rawText`：粘贴的节点文本（可空）
- `saveUrlsToConfig`：是否把订阅 URL 追加写入 `proxy.subscription.urls`（默认 `true`）

行为说明：
- 订阅抓取失败时会尽量使用缓存（取决于配置 `proxy.subscription.useCacheOnFail/cacheDir/cacheTtlSec`）
- 会按 `nodeKey(type|host|port|id/password/method)` 去重
- `insertedPreview` 最多返回 50 条，且仅包含 **新增** 节点（已存在的不会返回）

成功响应示例：

```json
{
  "ok": true,
  "parsed": 404,
  "inserted": 120,
  "skippedExisting": 284,
  "insertedPreview": [
    { "type": "vless", "tag": "xx", "host": "1.2.3.4", "port": 443 }
  ],
  "subscriptionError": null,
  "configUpdated": true,
  "urlsAdded": 1,
  "urlsTotal": 1,
  "nodeTotal": 520,
  "dbPath": "C:\\...\\data\\proxy.sqlite"
}
```

常见错误：
- 400 `missing_input`：`subscriptionUrls/rawText` 都为空
- 500 `proxy_db_open_failed`
- 500 `proxy_import_failed`

## 极限面板 JSON（非 WebUI 专用）

前端如果需要在页面展示结果，可直接请求在线 JSON：

- `GET /gs/hyperpanel`
- `GET /sr/hyperpanel`
- `GET /zzz/hyperpanel`
- `GET /presets/<game>/<uid>.json`

> `/<game>/hyperpanel` 会优先返回默认 UID 的 `out/<game>/<uid>.json`；文件不存在时返回 404（`error=not_found`）。
