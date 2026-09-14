package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	version        = "0.1.0"
	configFile     = "/etc/sb-agent/config.json"
	stateFile      = "/var/lib/sb-agent/state.json"
	singBoxConfig  = "/etc/sing-box/config.json"
	apiPrefix      = "/api/sbmonitor/v1"
	nftTable       = "sbmonitor"
	defaultService = "sing-box"
)

type Config struct {
	Server            string `json:"server"`
	Name              string `json:"name"`
	RegistrationToken string `json:"registration_token,omitempty"`
	NodeID            string `json:"node_id,omitempty"`
	AgentToken        string `json:"agent_token,omitempty"`
	ConfigPath        string `json:"config_path"`
	ServiceName       string `json:"service_name"`
	IntervalSeconds   int    `json:"interval_seconds"`
}

type Inbound struct {
	Port  int      `json:"port"`
	Type  string   `json:"type"`
	Tag   string   `json:"tag"`
	Users []string `json:"users"`
}

type DirectionState struct {
	LastRaw uint64 `json:"last_raw"`
	Total   uint64 `json:"total"`
	Rate    uint64 `json:"-"`
	Seen    bool   `json:"seen"`
}

type PortState struct {
	Upload   DirectionState `json:"upload"`
	Download DirectionState `json:"download"`
}

type AgentState struct {
	PortsHash   string               `json:"ports_hash"`
	Ports       map[string]PortState `json:"ports"`
	LastSample  time.Time            `json:"last_sample"`
	LastLogUnix int64                `json:"last_log_unix"`
}

type ReportCounter struct {
	Port          int    `json:"port"`
	UploadTotal   uint64 `json:"upload_total"`
	DownloadTotal uint64 `json:"download_total"`
	UploadRate    uint64 `json:"upload_rate"`
	DownloadRate  uint64 `json:"download_rate"`
}

type RegisterRequest struct {
	RegistrationToken string `json:"registration_token"`
	Name              string `json:"name"`
	Hostname          string `json:"hostname"`
	Arch              string `json:"arch"`
	AgentVersion      string `json:"agent_version"`
}

type RegisterResponse struct {
	OK         bool   `json:"ok"`
	Error      string `json:"error"`
	NodeID     string `json:"node_id"`
	AgentToken string `json:"agent_token"`
	Name       string `json:"name"`
}

type Report struct {
	NodeID       string          `json:"node_id"`
	Timestamp    int64           `json:"timestamp"`
	Hostname     string          `json:"hostname"`
	Arch         string          `json:"arch"`
	AgentVersion string          `json:"agent_version"`
	Singbox      SingboxStatus   `json:"singbox"`
	Inbounds     []Inbound       `json:"inbounds"`
	Counters     []ReportCounter `json:"counters"`
	Events       []string        `json:"events,omitempty"`
}

type SingboxStatus struct {
	Running bool   `json:"running"`
	Version string `json:"version"`
}

type apiResponse struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

var httpClient = &http.Client{
	Timeout: 15 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return errors.New("redirect refused: configure the final HTTPS endpoint")
	},
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "init":
		if err := initConfig(os.Args[2:]); err != nil {
			log.Fatal(err)
		}
	case "run":
		if err := runAgent(); err != nil {
			log.Fatal(err)
		}
	case "once":
		if err := runOnce(); err != nil {
			log.Fatal(err)
		}
	case "version", "--version", "-v":
		fmt.Println(version)
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Println("sb-agent init --server URL --token TOKEN --name NAME")
	fmt.Println("sb-agent run")
	fmt.Println("sb-agent once")
	fmt.Println("sb-agent version")
}

func initConfig(args []string) error {
	if _, err := os.Stat(configFile); err == nil {
		return errors.New("Agent 配置已存在；升级请使用安装脚本 --update，不覆盖节点身份")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	flags := flag.NewFlagSet("init", flag.ContinueOnError)
	serverURL := flags.String("server", "", "Komari server URL")
	token := flags.String("token", "", "one-time registration token")
	name := flags.String("name", "", "node display name")
	service := flags.String("service", defaultService, "sing-box systemd service")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*serverURL) == "" || strings.TrimSpace(*token) == "" || strings.TrimSpace(*name) == "" {
		return errors.New("server、token 和 name 都不能为空")
	}
	parsed, err := url.Parse(strings.TrimRight(*serverURL, "/"))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return errors.New("Komari 地址无效，必须是完整的 http:// 或 https:// 地址")
	}
	if _, err := os.Stat(singBoxConfig); err != nil {
		return fmt.Errorf("找不到固定配置文件 %s: %w", singBoxConfig, err)
	}
	if _, err := parseSingboxConfig(singBoxConfig); err != nil {
		return fmt.Errorf("Sing-box 配置无法解析: %w", err)
	}

	cfg := Config{
		Server:            strings.TrimRight(*serverURL, "/"),
		Name:              strings.TrimSpace(*name),
		RegistrationToken: strings.TrimSpace(*token),
		ConfigPath:        singBoxConfig,
		ServiceName:       strings.TrimSpace(*service),
		IntervalSeconds:   5,
	}
	if cfg.ServiceName == "" {
		cfg.ServiceName = defaultService
	}
	if err := atomicWriteJSON(configFile, cfg, 0o600); err != nil {
		return err
	}
	fmt.Printf("配置已写入 %s\n", configFile)
	return nil
}

func runAgent() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	if err := ensureRegistered(&cfg); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	interval := time.Duration(cfg.IntervalSeconds) * time.Second
	if interval < 2*time.Second || interval > 5*time.Minute {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	state, err := loadAgentState()
	if err != nil {
		return fmt.Errorf("累计状态损坏，请先备份检查，不自动清零: %w", err)
	}
	lastSave := time.Time{}
	log.Printf("已连接节点 %s，固定配置路径 %s", cfg.Name, cfg.ConfigPath)

	for {
		if err := collectAndReport(&cfg, &state); err != nil {
			log.Printf("上报失败: %v", err)
		}
		if time.Since(lastSave) >= 30*time.Second {
			if err := atomicWriteJSON(stateFile, state, 0o600); err != nil {
				log.Printf("保存累计状态失败: %v", err)
			} else {
				lastSave = time.Now()
			}
		}

		select {
		case <-ctx.Done():
			_ = atomicWriteJSON(stateFile, state, 0o600)
			return nil
		case <-ticker.C:
		}
	}
}

func runOnce() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	if err := ensureRegistered(&cfg); err != nil {
		return err
	}
	state, err := loadAgentState()
	if err != nil {
		return err
	}
	if err := collectAndReport(&cfg, &state); err != nil {
		return err
	}
	return atomicWriteJSON(stateFile, state, 0o600)
}

func loadConfig() (Config, error) {
	var cfg Config
	if err := readJSON(configFile, &cfg); err != nil {
		return cfg, fmt.Errorf("读取 %s 失败: %w", configFile, err)
	}
	if cfg.ConfigPath != singBoxConfig {
		return cfg, fmt.Errorf("配置路径必须是 %s", singBoxConfig)
	}
	if cfg.IntervalSeconds == 0 {
		cfg.IntervalSeconds = 5
	}
	if cfg.ServiceName == "" {
		cfg.ServiceName = defaultService
	}
	return cfg, nil
}

func ensureRegistered(cfg *Config) error {
	if cfg.NodeID != "" && cfg.AgentToken != "" {
		return nil
	}
	if cfg.RegistrationToken == "" {
		return errors.New("没有可用的注册密钥，请从插件页面重新生成安装命令")
	}
	hostname, _ := os.Hostname()
	request := RegisterRequest{
		RegistrationToken: cfg.RegistrationToken,
		Name:              cfg.Name,
		Hostname:          hostname,
		Arch:              runtime.GOARCH,
		AgentVersion:      version,
	}
	var response RegisterResponse
	if err := postJSON(cfg.Server+apiPrefix+"/agent/register", "", request, &response); err != nil {
		return fmt.Errorf("注册失败: %w", err)
	}
	if !response.OK || response.NodeID == "" || response.AgentToken == "" {
		return fmt.Errorf("注册失败: %s", response.Error)
	}
	cfg.NodeID = response.NodeID
	cfg.AgentToken = response.AgentToken
	cfg.RegistrationToken = ""
	if response.Name != "" {
		cfg.Name = response.Name
	}
	if err := atomicWriteJSON(configFile, cfg, 0o600); err != nil {
		return fmt.Errorf("保存正式身份失败: %w", err)
	}
	log.Printf("节点注册成功: %s", cfg.Name)
	return nil
}

func collectAndReport(cfg *Config, state *AgentState) error {
	inbounds, err := parseSingboxConfig(cfg.ConfigPath)
	if err != nil {
		return err
	}
	ports := uniquePorts(inbounds)
	now := time.Now()
	raw, rawErr := readNftCounters()
	if rawErr == nil {
		updateTraffic(state, raw, now)
	}
	hash := hashPorts(ports)
	if rawErr != nil || state.PortsHash != hash || !hasExpectedCounters(raw, ports) {
		if err := rebuildNft(ports); err != nil {
			return fmt.Errorf("创建 nftables 计数器失败: %w", err)
		}
		state.PortsHash = hash
		for key, value := range state.Ports {
			value.Upload.LastRaw = 0
			value.Upload.Seen = false
			value.Upload.Rate = 0
			value.Download.LastRaw = 0
			value.Download.Seen = false
			value.Download.Rate = 0
			state.Ports[key] = value
		}
		state.LastSample = now
	}

	for _, port := range ports {
		key := strconv.Itoa(port)
		if _, ok := state.Ports[key]; !ok {
			state.Ports[key] = PortState{}
		}
	}

	events := []string{}
	if state.LastLogUnix == 0 || now.Unix()-state.LastLogUnix >= 30 {
		events = collectWarningLogs(cfg.ServiceName, state.LastLogUnix)
	}

	hostname, _ := os.Hostname()
	report := Report{
		NodeID:       cfg.NodeID,
		Timestamp:    now.Unix(),
		Hostname:     hostname,
		Arch:         runtime.GOARCH,
		AgentVersion: version,
		Singbox: SingboxStatus{
			Running: serviceRunning(cfg.ServiceName),
			Version: singboxVersion(),
		},
		Inbounds: inbounds,
		Counters: reportCounters(ports, state),
		Events:   events,
	}
	var response apiResponse
	if err := postJSON(cfg.Server+apiPrefix+"/agent/report", cfg.AgentToken, report, &response); err != nil {
		return err
	}
	if !response.OK {
		return errors.New(response.Error)
	}
	if state.LastLogUnix == 0 || now.Unix()-state.LastLogUnix >= 30 {
		state.LastLogUnix = now.Unix() - 1
	}
	return nil
}

func parseSingboxConfig(filename string) ([]Inbound, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("读取 Sing-box 配置失败: %w", err)
	}
	var root struct {
		Inbounds []struct {
			Type       string `json:"type"`
			Tag        string `json:"tag"`
			ListenPort int    `json:"listen_port"`
			Users      []struct {
				Name string `json:"name"`
			} `json:"users"`
		} `json:"inbounds"`
	}
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, fmt.Errorf("%s 不是有效 JSON: %w", filename, err)
	}
	result := make([]Inbound, 0, len(root.Inbounds))
	for _, item := range root.Inbounds {
		if item.ListenPort < 1 || item.ListenPort > 65535 {
			continue
		}
		users := make([]string, 0, len(item.Users))
		for _, user := range item.Users {
			name := strings.TrimSpace(user.Name)
			if name != "" {
				users = append(users, name)
			}
		}
		result = append(result, Inbound{Port: item.ListenPort, Type: item.Type, Tag: item.Tag, Users: users})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Port < result[j].Port })
	return result, nil
}

func uniquePorts(inbounds []Inbound) []int {
	seen := map[int]bool{}
	ports := make([]int, 0, len(inbounds))
	for _, inbound := range inbounds {
		if !seen[inbound.Port] {
			seen[inbound.Port] = true
			ports = append(ports, inbound.Port)
		}
	}
	sort.Ints(ports)
	return ports
}

func hashPorts(ports []int) string {
	values := make([]string, len(ports))
	for index, port := range ports {
		values[index] = strconv.Itoa(port)
	}
	sum := sha256.Sum256([]byte(strings.Join(values, ",")))
	return hex.EncodeToString(sum[:])
}

func rebuildNft(ports []int) error {
	var rules strings.Builder
	// Delete and replace in one nft transaction: failure leaves existing rules intact.
	if exec.Command("nft", "list", "table", "inet", nftTable).Run() == nil {
		rules.WriteString("delete table inet " + nftTable + "\n")
	}
	rules.WriteString("table inet " + nftTable + " {\n")
	rules.WriteString(" chain input { type filter hook input priority filter; policy accept;\n")
	for _, port := range ports {
		fmt.Fprintf(&rules, "  tcp dport %d counter comment \"sbm:upload:tcp:%d\"\n", port, port)
		fmt.Fprintf(&rules, "  udp dport %d counter comment \"sbm:upload:udp:%d\"\n", port, port)
	}
	rules.WriteString(" }\n")
	rules.WriteString(" chain output { type filter hook output priority filter; policy accept;\n")
	for _, port := range ports {
		fmt.Fprintf(&rules, "  tcp sport %d counter comment \"sbm:download:tcp:%d\"\n", port, port)
		fmt.Fprintf(&rules, "  udp sport %d counter comment \"sbm:download:udp:%d\"\n", port, port)
	}
	rules.WriteString(" }\n}\n")
	command := exec.Command("nft", "-f", "-")
	command.Stdin = strings.NewReader(rules.String())
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

var nftComment = regexp.MustCompile(`^sbm:(upload|download):(tcp|udp):(\d+)$`)

func readNftCounters() (map[string]uint64, error) {
	output, err := exec.Command("nft", "-j", "list", "table", "inet", nftTable).Output()
	if err != nil {
		return nil, err
	}
	var document struct {
		Nftables []map[string]json.RawMessage `json:"nftables"`
	}
	if err := json.Unmarshal(output, &document); err != nil {
		return nil, err
	}
	result := map[string]uint64{}
	for _, entry := range document.Nftables {
		rawRule, ok := entry["rule"]
		if !ok {
			continue
		}
		var rule struct {
			Comment string                       `json:"comment"`
			Expr    []map[string]json.RawMessage `json:"expr"`
		}
		if json.Unmarshal(rawRule, &rule) != nil || nftComment.FindStringSubmatch(rule.Comment) == nil {
			continue
		}
		for _, expression := range rule.Expr {
			rawCounter, ok := expression["counter"]
			if !ok {
				continue
			}
			var counter struct {
				Bytes uint64 `json:"bytes"`
			}
			if json.Unmarshal(rawCounter, &counter) == nil {
				result[rule.Comment] = counter.Bytes
			}
		}
	}
	return result, nil
}

func hasExpectedCounters(raw map[string]uint64, ports []int) bool {
	if len(ports) == 0 {
		return true
	}
	for _, port := range ports {
		for _, direction := range []string{"upload", "download"} {
			for _, protocol := range []string{"tcp", "udp"} {
				if _, ok := raw[fmt.Sprintf("sbm:%s:%s:%d", direction, protocol, port)]; !ok {
					return false
				}
			}
		}
	}
	return true
}

func updateTraffic(state *AgentState, raw map[string]uint64, now time.Time) {
	if state.Ports == nil {
		state.Ports = map[string]PortState{}
	}
	elapsed := now.Sub(state.LastSample).Seconds()
	if elapsed <= 0 || elapsed > 3600 {
		elapsed = 0
	}
	combined := map[string]struct{ upload, download uint64 }{}
	for comment, bytesValue := range raw {
		parts := nftComment.FindStringSubmatch(comment)
		if parts == nil {
			continue
		}
		port := parts[3]
		value := combined[port]
		if parts[1] == "upload" {
			value.upload += bytesValue
		} else {
			value.download += bytesValue
		}
		combined[port] = value
	}
	for port, current := range combined {
		value := state.Ports[port]
		value.Upload = advanceDirection(value.Upload, current.upload, elapsed)
		value.Download = advanceDirection(value.Download, current.download, elapsed)
		state.Ports[port] = value
	}
	state.LastSample = now
}

func advanceDirection(previous DirectionState, current uint64, elapsed float64) DirectionState {
	delta := uint64(0)
	if previous.Seen {
		if current >= previous.LastRaw {
			delta = current - previous.LastRaw
		} else {
			delta = current
		}
	} else {
		delta = current
	}
	previous.Total += delta
	previous.LastRaw = current
	previous.Seen = true
	if elapsed > 0 {
		previous.Rate = uint64(float64(delta) / elapsed)
	} else {
		previous.Rate = 0
	}
	return previous
}

func reportCounters(ports []int, state *AgentState) []ReportCounter {
	result := make([]ReportCounter, 0, len(ports))
	for _, port := range ports {
		value := state.Ports[strconv.Itoa(port)]
		result = append(result, ReportCounter{
			Port:          port,
			UploadTotal:   value.Upload.Total,
			DownloadTotal: value.Download.Total,
			UploadRate:    value.Upload.Rate,
			DownloadRate:  value.Download.Rate,
		})
	}
	return result
}

func serviceRunning(service string) bool {
	if exec.Command("systemctl", "is-active", "--quiet", service).Run() == nil {
		return true
	}
	return exec.Command("pgrep", "-x", "sing-box").Run() == nil
}

var cachedVersion string
var cachedVersionAt time.Time

func singboxVersion() string {
	if cachedVersion != "" && time.Since(cachedVersionAt) < 5*time.Minute {
		return cachedVersion
	}
	output, err := exec.Command("sing-box", "version").CombinedOutput()
	if err != nil {
		return ""
	}
	line := strings.TrimSpace(strings.SplitN(string(output), "\n", 2)[0])
	cachedVersion = line
	cachedVersionAt = time.Now()
	return cachedVersion
}

func collectWarningLogs(service string, sinceUnix int64) []string {
	if sinceUnix <= 0 {
		sinceUnix = time.Now().Add(-30 * time.Second).Unix()
	}
	args := []string{"-u", service, "--since", "@" + strconv.FormatInt(sinceUnix, 10), "--no-pager", "-n", "200", "-o", "short-iso"}
	output, err := exec.Command("journalctl", args...).CombinedOutput()
	if err != nil {
		return nil
	}
	lines := strings.Split(string(output), "\n")
	result := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "-- No entries --") {
			continue
		}
		upper := strings.ToUpper(line)
		if !strings.Contains(upper, "WARN") && !strings.Contains(upper, "ERROR") && !strings.Contains(upper, "FATAL") && !strings.Contains(upper, "PANIC") {
			continue
		}
		if len(line) > 2000 {
			line = line[:2000]
		}
		result = append(result, line)
	}
	return result
}

func postJSON(endpoint, token string, input any, output any) error {
	payload, err := json.Marshal(input)
	if err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "sb-agent/"+version)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var apiError apiResponse
		if json.Unmarshal(body, &apiError) == nil && apiError.Error != "" {
			return fmt.Errorf("HTTP %d: %s", response.StatusCode, apiError.Error)
		}
		return fmt.Errorf("HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	if output != nil {
		if err := json.Unmarshal(body, output); err != nil {
			return err
		}
	}
	return nil
}

func loadAgentState() (AgentState, error) {
	state := AgentState{Ports: map[string]PortState{}}
	if err := readJSON(stateFile, &state); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return state, nil
		}
		return state, err
	}
	if state.Ports == nil {
		state.Ports = map[string]PortState{}
	}
	return state, nil
}

func readJSON(filename string, target any) error {
	data, err := os.ReadFile(filename)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func atomicWriteJSON(filename string, value any, mode os.FileMode) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(filename), ".sb-agent-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(append(data, '\n')); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, filename)
}
