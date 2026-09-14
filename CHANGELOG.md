# 更新日志

本项目遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

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
