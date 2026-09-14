#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")" && pwd)"
agent_dir="${project_dir}/agent"
plugin_dir="${project_dir}/plugin"
dist_dir="${project_dir}/dist"

mkdir -p "$dist_dir" "${plugin_dir}/bin"

for command_name in go node zip sha256sum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少构建依赖：${command_name}" >&2
    exit 1
  fi
done

version="$(node -p "require('${plugin_dir}/komari-plugin.json').version")"
if [[ -z "$version" ]]; then
  echo "无法从 komari-plugin.json 读取版本号" >&2
  exit 1
fi

echo "[1/5] 运行 Agent 测试"
(cd "$agent_dir" && go test ./... && go vet ./...)

echo "[2/5] 构建 linux/amd64 Agent"
(cd "$agent_dir" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -buildvcs=false -trimpath -ldflags="-s -w" -o "${plugin_dir}/bin/sb-agent-linux-amd64" .)

echo "[3/5] 构建 linux/arm64 Agent"
(cd "$agent_dir" && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -buildvcs=false -trimpath -ldflags="-s -w" -o "${plugin_dir}/bin/sb-agent-linux-arm64" .)

echo "[4/5] 生成校验文件并测试插件"
(cd "${plugin_dir}/bin" && sha256sum sb-agent-linux-amd64 sb-agent-linux-arm64 > checksums.txt)
node "${project_dir}/tests/plugin.test.js"

echo "[5/5] 打包 Komari 插件"
archive="${dist_dir}/komari-singbox-monitor-${version}.zip"
rm -f "$archive"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
cp -a "${plugin_dir}/." "$staging/"
mkdir -p "$staging/SOURCE/agent"
cp "${project_dir}/README.md" "${project_dir}/LICENSE" "$staging/"
cp "${agent_dir}/go.mod" "${agent_dir}/main.go" "${agent_dir}/main_test.go" "$staging/SOURCE/agent/"
cp "${project_dir}/build.sh" "$staging/SOURCE/"
(cd "$staging" && zip -q -r "$archive" .)
sha256sum "$archive" > "${archive}.sha256"

echo "完成：$archive"
