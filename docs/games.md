# 游戏支持（gs / sr / zzz）

本项目使用内部代号区分不同游戏：

| 代号 | 游戏 | UID 说明 | Enka 路径（参考） | 产物 |
|---|---|---|---|---|
| `gs` | 原神 | 通常 9 位（示例：`100000000`） | `https://enka.network/api/uid/<uid>` | `out/gs/<uid>.json` |
| `sr` | 崩坏：星穹铁道 | 通常 9 位（示例：`100000000`） | `https://enka.network/api/hsr/uid/<uid>` | `out/sr/<uid>.json` |
| `zzz` | 绝区零 | **8 位**（示例：`10000000`） | `https://enka.network/api/zzz/uid/<uid>`（代码内带备用域名） | `out/zzz/<uid>.json` |

## 面板 JSON 访问

启动后默认提供在线 JSON（不是静态文件下载站的目录浏览，而是直接返回 JSON 内容）：

- `GET /gs/hyperpanel`
- `GET /sr/hyperpanel`
- `GET /zzz/hyperpanel`
- `GET /presets/<game>/<uid>.json`

## 采样来源

- `samples.mode: playerdata`：从本地 Yunzai `data/PlayerData/<game>` 采样（当前仅 `gs/sr` 支持）
- `samples.mode: enka`：调用 Enka API 按 UID 列表/UID 范围采样（`gs/sr/zzz` 支持）

更多配置项见：`docs/config.md`。

