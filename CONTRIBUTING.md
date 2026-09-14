# 参与贡献

感谢你愿意改进 Komari Sing-box Monitor。

## 提交问题

提交 Bug 前请先确认：

1. Komari 版本不低于插件清单声明的最低版本。
2. Sing-box 配置文件位于 `/etc/sing-box/config.json`，且 `sing-box check -c /etc/sing-box/config.json` 通过。
3. 目标机器使用 systemd，架构为 amd64 或 arm64。
4. 问题中不要粘贴密码、UUID、Reality 私钥、注册密钥或 Agent Token。

请同时提供 Komari 版本、Sing-box 版本、Linux 发行版、CPU 架构、复现步骤和脱敏日志。

## 本地开发

要求：Go 1.22+、Node.js 20+、zip、sha256sum。

```bash
make test
make build
```

构建产物位于 `dist/`。提交代码时不要提交 `dist/` 或 `plugin/bin/` 下生成的二进制文件；GitHub Release 会自动构建它们。

## Pull Request

- 一个 PR 只解决一个主题。
- 新功能或修复应尽量补充测试。
- 不得加入远程 Shell、任意命令执行或修改 Sing-box 配置的能力。
- 保持 `/etc/sing-box/config.json` 为固定只读配置路径。
- 涉及权限变更时，必须在 PR 描述和 README 中说明原因。
