# 更新日志

本项目遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

## [0.1.3] - 2026-09-15

- Recognize Komari's code-less `GoError` when `state.json` is absent on first install.
- Apply the same missing-file handling when a node has no history file yet.

## [0.1.2] - 2026-09-15

- Handle first installation without depending on Node ENOENT error codes in Komari.
- Preserve unreadable/corrupt state and skip unload writes when state loading failed.
- Add regression tests simulating GoError without a code property.

## [0.1.1] - 2026-09-14

- Replace personal examples with fictional demo data and generic contributor attribution.
- Withdraw the superseded prerelease package. Repository history is not rewritten.

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
