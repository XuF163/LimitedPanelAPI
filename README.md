# LimitedPanelAPI（ExtremePanelAPI）

生成并托管「极限面板」JSON 的服务端：支持 **原神（gs）/ 崩铁（sr）/ 绝区零（zzz）**，适用于特定分支的miao-plugin或liangshi

## 能做什么

- **极限面板生成**：基于样本统计每个角色的“高分且常见”的词条组合，合成一份 `out/<game>/<uid>.json` 极限面板。
- **两种采样来源**
  - `playerdata`：读取本地 Yunzai 的 `data/PlayerData/<game>`（仅 `gs/sr`）。
  - `enka`：通过 Enka API 扫 UID 段/UID 列表采样（`gs/sr/zzz`）。
- **HTTP 接口**：默认监听 `0.0.0.0:4567`，提供 `/gs/hyperpanel`、`/sr/hyperpanel`、`/zzz/hyperpanel` 在线 JSON。
- **SQLite 落盘**：扫描状态、（可选）原始响应、全局限速、代理测活记录都写 SQLite，避免生成海量小 json 文件。
- **可选代理池（v2ray / mihomo）**：自动下载内核、解析订阅、测活可用节点，并用于并发抓取 Enka（可关闭）。

## 目录结构（关键）

- `config/defSet.yaml`：默认配置（不要改）
- `config/config.yaml`：用户配置（不存在会自动从默认配置生成）
- `dist/`：TypeScript 构建产物（`npm start` 会自动生成/更新）
- `data/scan.sqlite`：Enka 扫描状态 + raw（gzip）+ 全局限速槽位
- `data/proxy.sqlite`：代理节点启动/测活记录（可选）
- `data/samples/<game>/*.jsonl`：每个角色的样本集合（采样输出）
- `out/<game>/<uid>.json`：生成的极限面板（HTTP 会直接返回这个 JSON）
- `resources/meta-gs`、`resources/meta-sr`：GS/SR meta（可选：CNB / miao-plugin）
- `resources/zzz-plugin` 或 `plugins/ZZZ-Plugin`：ZZZ 资源来源（见下文）
- `src/ui/index.html`：WebUI 静态页（构建时会拷贝到 `dist/ui/`）

## 环境要求

- Node.js **22+**（依赖 `node:sqlite`，目前为实验特性，运行时会看到 `ExperimentalWarning`）
- Windows/Linux/macOS 均可
- 如启用 `meta.autoSync` / `zzz.source.type=github`：需要 `git`

## 快速开始（推荐）

1) 安装依赖
```powershell
cd temp/LimitedPanelAPI
npm i
```

2) 配置
- 首次启动会自动生成 `config/config.yaml`
- 也可直接参考：`config/config.example.yaml`
- 配置说明：`docs/config.md`

3) 启动（自动：可选代理池 -> 拉 meta -> 采样 -> 生成 preset -> 启 HTTP）
```powershell
cd temp/LimitedPanelAPI
npm start
```

4) 访问
- `GET /healthz`
- `GET /gs/hyperpanel`
- `GET /sr/hyperpanel`
- `GET /zzz/hyperpanel`
- `GET /presets/<game>/<uid>.json`
- `GET /ui`（WebUI：推荐用“简洁配置”保存，配置项更少）
- `GET /api/runtime/status`（运行时状态：并发/退避/代理池/扫描统计）
- `GET /api/proxy/pool/status`、`POST /api/proxy/pool/rebuild`
- `POST /api/samples/start`、`POST /api/samples/stop`
- `POST /api/presets/generate`

如果某个游戏的 `out/<game>/<uid>.json` 尚未生成，对应 `/<game>/hyperpanel` 会返回 404（先跑一次该游戏的生成即可）。

## 启动行为（一次跑 gs/sr/zzz）

`npm start` 会依次处理并生成：`gs`、`sr`、`zzz` 三个游戏的极限面板（然后启动 HTTP 服务）。

如果某个游戏的采样源未就绪（例如：`sr` 缺少 PlayerData；`zzz` 未配置 Enka UID 范围），会打印 `skipped/failed` 提示并继续跑其它游戏。

## Enka 限速（没代理时：三个游戏加起来 20 秒 1 次）

当 **没有配置代理** 或 **没有可用节点** 时，为避免直连触发 429，本项目会使用 `data/scan.sqlite` 做“跨进程全局限速”：

- 配置：`samples.enka.noProxyDelayMs`（默认 `20000` = 20 秒）
- 含义：**gs/sr/zzz 三个游戏加起来**，同一台机器上所有进程共享 1 个节流槽位
- 前提：这些进程共用同一个 `SCAN_DB_PATH`（默认就是 `data/scan.sqlite`）

有代理时则采用“按代理数量分桶节流”（`samples.enka.delayMs` 为每个代理桶的间隔）。

## ZZZ 资源来源（必须）

ZZZ 的面板转换/评分/专武识别依赖 `ZZZ-Plugin` 的资源文件（如 `model/Enka/formater.js`、`resources/map/*.json` 等）。

配置：`zzz.source`
- `type: yunzai-plugin`：使用本地 `Yunzai/plugins/ZZZ-Plugin`（最稳）
- `type: github`：自动拉取 `ZZZure/ZZZ-Plugin` 到 `resources/zzz-plugin`

## 常见报错

- `Missing meta files ...`：打开 `GET /ui` 点击“同步 meta”，或重启（默认 `meta.autoSync: true` 会自动拉取）
- `Missing PlayerData dir ...`：`samples.mode=playerdata` 时需要正确的 `data/PlayerData/<game>` 路径（可配置 `samples.playerdata.dir`）
- `proxy enabled but no usable node found`：把 `proxy.required: false` 或 `proxy.enabled: false`，或换订阅/提高 `probeCount`
- 大量 `429`：并发已改为“自适应 + 指数退避”，不再支持手动并发上限；建议启用/扩充代理池、增大 `delayMs/noProxyDelayMs`，并等待退避恢复

## 免责声明

本项目仅用于技术研究与本地测试。请遵守上游服务条款与所在地区法律法规，合理控制请求频率，避免对第三方服务造成压力。

## 致谢 / 参考项目

- `qsyhh/miao-plugin`: https://github.com/qsyhh/miao-plugin
- `liangshi-calc`: https://github.com/liangshi233/liangshi-calc/commits/master/
- `yoimiya-kokomi/miao-plugin`: https://github.com/yoimiya-kokomi/miao-plugin
