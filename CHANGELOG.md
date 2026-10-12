# 更新日志

本项目遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

## [0.3.1] - 2026-10-12

- 支持监控 Hysteria2 / Hysteria / TUIC 入站上的用户：这类协议所有流量都走一条 UDP（QUIC）连接，内核的 TCP 连接表里看不到，0.3.0 会把它们的在连数一直算成 0，上线后约 1 分钟就误报下线。现在 Agent 把这类入站标记为「不能统计在连数」，和开了 multiplex 的入站一样按 `session_idle_seconds` 的旧规则判定（多久没有新连接算下线）。
- 已知限制：这类入站上一条连接用很久（例如长时间看视频）时，仍可能在 `session_idle_seconds` 后被判下线、随后又报上线。

升级：只需要更换装有这类入站的节点上的 Agent；插件只改了版本号和配置说明。

## [0.3.0] - 2026-10-12

按「连接是否还开着」判定上线和下线，下线通知带上本次访问的全部域名和时间。

- 修复看视频、长连接时被反复误报下线：之前只看「多久没有新连接」，一条连接用 20 分钟也会在 5 分钟后被判下线，随后又报上线。
- Agent 用连接 ID 把日志里的「来源地址」和「目标域名」对上，再对照内核里该入站端口上仍然建立着的 TCP 连接（读 `/proc/net/tcp`、`/proc/net/tcp6`），每次上报带 `live`（还开着的真实连接数）。不需要改 sing-box 配置，也不用重启 sing-box。
- 上线：出现第 2 条真实连接，或单条连接保持超过 `online_confirm_seconds`（默认 15 秒）才推送；手机锁屏时偶尔一条转瞬即逝的后台请求（例如 OCSP 校验）不再推送上线/下线。上线时间按第一条连接的日志时间算。
- 下线：所有连接都断开、且 `offline_grace_seconds`（默认 60 秒）内没有新连接才判定。下线时间按最后一次还有连接的上报算（误差一个上报周期，默认 5 秒），时长不再包含等待时间。
- 下线的 Telegram 通知列出本次会话访问过的每个域名：首次访问时间、连接次数、最后一次访问时间；内容太长时自动拆成多条。
- Agent 改用 journal 游标续读日志、并记录每条连接的真实日志时间，不会重复或漏计同一秒内的连接；上报失败时访问记录保留到下次上报成功。
- 探针失联时不猜测下线：30 秒没有上报就先挂起，超过 10 分钟才结束会话并在通知里注明。
- 开了 multiplex 的入站、以及 0.3.0 之前的探针无法统计在连数，仍按 `session_idle_seconds` 的旧规则判定。
- UDP 连接只记录访问（域名和时间），不计入在连数。
- 新增配置项：`offline_grace_seconds`、`online_confirm_seconds`。「连接监控」页在线时显示「在连 / 本次连接」。

升级：插件和各节点的 Agent 都要换成 0.3.0（只换插件时仍按旧规则工作）。

## [0.2.1] - 2026-09-28

修复上线误报：过滤客户端测速/健康检查探测，只在真实访问时判定上线，并展示真实域名。

- Agent 从 `[user] inbound connection to <目标>` 行解析目标域名；对 `www.cloudflare.com`、`gstatic.com`、`captive.apple.com` 等测速/连通性探测目标不计入连接数（单独计为 `probes`），只有连真实网站才 `conn_count++`。
- 之前在经第三方前置（如机场中转）接入的落地节点上，客户端的节点测速探测（清一色打向 `www.cloudflare.com:443`、来源为前置中转 IP）会被误判成用户上线；此版本修复。
- Agent 上报新增 `domains`（去重、限量）与 `probes` 字段；插件在会话与事件中记录真实访问域名。
- 「连接监控」页按用户展示最近访问域名；上线的 Telegram 通知附带访问的站点样例。
- 不再在通知/面板里把前置中转 IP 当作用户来源展示。

## [0.2.0] - 2026-09-28

新增：按入站的用户上线/会话监控与 Telegram 通知。

- Agent 每次上报新增 `activity` 字段：扫描 systemd journal 的 INFO 连接行，按 inbound tag 汇总 `{连接数, 最后活跃时间, 来源}`，过滤端口扫描噪音（invalid request / bad header）。
- 插件新增会话状态机：对配置里 `watch_rules` 指定的入站 tag 做上线/离线判定（空闲超时可配），产生上下线事件。
- 插件通过 `fetch` 直连 Telegram Bot API 推送上下线通知（不依赖 Komari ≥1.6 的通知渠道）；采用持久化待发队列 + cron 重试，避免请求处理器无法 await 时漏发。
- 新增管理页「连接监控」`watch.html` 与只读接口 `GET /api/sbmonitor/v1/admin/watch`：按用户分组展示各节点在线/会话时长/连接数/来源与上下线记录，复用 Komari 管理员登录鉴权。
- 新增配置项：`watch_rules`、`session_idle_seconds`、`tg_bot_token`、`tg_chat_id`、`notify_online`、`notify_offline`。
- 持久化状态 schema 升到 2（新增 `watch` / `userEvents` / `pending`，向后兼容旧状态文件）。

## [0.1.3] - 2026-09-15

- Recognize Komari's code-less `GoError` when `state.json` is absent on first install.
- Apply the same missing-file handling when a node has no history file yet.

## [0.1.2] - 2026-09-15

- Handle first installation without depending on Node ENOENT error codes in Komari.
- Preserve unreadable/corrupt state and skip unload writes when state loading failed.
- Add regression tests simulating GoError without a code property.

## [0.1.1] - 2026-09-14

- Refresh demo data and contributor attribution.

### Fixed before first release

- 校验文件改为相对文件名，下载后可直接验证。
- 离线节点不再显示旧速率或追加过时速率历史。
- 拒绝非对象 JSON，忽略空数组元素，使用服务端时间统计。
- 损坏状态文件停止加载，不静默覆盖；上报确认前持久化主控数据。
- Agent 拒绝重定向；失败上报不推进日志游标。
- nftables 在单个事务中重建，避免失败后旧规则已被删除。
- 新增保留节点身份的升级入口，阻止重复初始化。
- 增加验证后发布预发布 ZIP 的工作流。

### Planned

- 可选的 Sing-box API / Clash API 实时连接采集
- 流量额度与告警
- 更细粒度的历史聚合

## [0.1.0] - 2026-09-14

### Added

- Komari 原生插件与管理页面
- 通用 Linux Agent，一次性 Token 注册和自定义节点名称
- 固定读取 `/etc/sing-box/config.json`
- 自动发现 inbound、端口、协议、tag 和用户名
- nftables TCP/UDP 上下行计数及速率计算
- 今日、本月和分钟历史流量
- Sing-box 服务状态、版本和 WARN 及以上日志
- 节点改名、端口别名和节点删除
- amd64、arm64 构建与一键安装/卸载脚本

[Unreleased]: https://github.com/K23Flux/komari-singbox-monitor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/K23Flux/komari-singbox-monitor/releases/tag/v0.1.0
