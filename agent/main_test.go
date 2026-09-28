package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
	"strings"
)

func TestParseSingboxConfigDoesNotExposeSecrets(t *testing.T) {
	directory := t.TempDir()
	filename := filepath.Join(directory, "config.json")
	content := `{
  "inbounds": [
    {
      "type": "shadowsocks",
      "tag": "ss2022",
      "listen_port": 30001,
      "password": "main-secret",
      "users": [{"name":"demo-user-a","password":"user-secret"}]
    },
    {
      "type": "vless",
      "tag": "vless-in",
      "listen_port": 30002,
      "users": [{"name":"demo-user-b","uuid":"secret-uuid"}]
    }
  ]
}`
	if err := os.WriteFile(filename, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	inbounds, err := parseSingboxConfig(filename)
	if err != nil {
		t.Fatal(err)
	}
	if len(inbounds) != 2 {
		t.Fatalf("expected 2 inbounds, got %d", len(inbounds))
	}
	if inbounds[0].Port != 30001 || inbounds[0].Users[0] != "demo-user-a" {
		t.Fatalf("unexpected inbound: %#v", inbounds[0])
	}
	if inbounds[1].Port != 30002 || inbounds[1].Users[0] != "demo-user-b" {
		t.Fatalf("unexpected inbound: %#v", inbounds[1])
	}
	encoded, err := json.Marshal(inbounds)
	if err != nil { t.Fatal(err) }
	for _, secret := range []string{"main-secret", "user-secret", "secret-uuid"} {
		if strings.Contains(string(encoded), secret) { t.Fatal("secret leaked in report") }
	}
}

func TestPostJSONRefusesRedirect(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("redirect target must never receive credentials")
	}))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	if err := postJSON(source.URL, "test-token", map[string]string{"registration_token":"test"}, nil); err == nil {
		t.Fatal("expected redirect rejection")
	}
}

func TestAdvanceDirectionHandlesCounterReset(t *testing.T) {
	value := DirectionState{LastRaw: 1000, Total: 5000, Seen: true}
	value = advanceDirection(value, 1300, 10)
	if value.Total != 5300 || value.Rate != 30 {
		t.Fatalf("normal delta failed: %#v", value)
	}
	value = advanceDirection(value, 200, 10)
	if value.Total != 5500 || value.Rate != 20 {
		t.Fatalf("reset delta failed: %#v", value)
	}
}

func TestUpdateTrafficCombinesTCPAndUDP(t *testing.T) {
	state := AgentState{Ports: map[string]PortState{}, LastSample: time.Unix(100, 0)}
	raw := map[string]uint64{
		"sbm:upload:tcp:30001":   1000,
		"sbm:upload:udp:30001":   500,
		"sbm:download:tcp:30001": 2000,
		"sbm:download:udp:30001": 250,
	}
	updateTraffic(&state, raw, time.Unix(110, 0))
	value := state.Ports["30001"]
	if value.Upload.Total != 1500 || value.Download.Total != 2250 {
		t.Fatalf("unexpected totals: %#v", value)
	}
}

func TestHostOnly(t *testing.T) {
	cases := map[string]string{
		"www.cloudflare.com:443":   "www.cloudflare.com",
		"1.2.3.4:80":               "1.2.3.4",
		"[2001:470:f912:6a::1]:443": "2001:470:f912:6a::1",
		"pixiv.net":                "pixiv.net",
	}
	for in, want := range cases {
		if got := hostOnly(in); got != want {
			t.Errorf("hostOnly(%q)=%q, want %q", in, got, want)
		}
	}
}

func TestIsHealthCheck(t *testing.T) {
	probes := []string{"www.cloudflare.com", "cp.cloudflare.com", "www.gstatic.com", "captive.apple.com", "www.msftconnecttest.com"}
	for _, h := range probes {
		if !isHealthCheck(h) {
			t.Errorf("isHealthCheck(%q) = false, want true", h)
		}
	}
	real := []string{"www.pixiv.net", "i.instagram.com", "youtube.com", "example.com"}
	for _, h := range real {
		if isHealthCheck(h) {
			t.Errorf("isHealthCheck(%q) = true, want false", h)
		}
	}
}

func TestInboundConnRe(t *testing.T) {
	// "to" line with [user] and destination
	line := "INFO[1] [2 0ms] inbound/shadowsocks[ss2022_wty]: [WTY] inbound connection to www.pixiv.net:443"
	m := inboundConnRe.FindStringSubmatch(line)
	if m == nil || m[1] != "ss2022_wty" || m[3] != "to" || m[4] != "www.pixiv.net:443" {
		t.Fatalf("to-line parse failed: %#v", m)
	}
	// "from" line with source
	line2 := "INFO[1] [2 0ms] inbound/shadowsocks[ss2022_wty]: inbound connection from 1.2.3.4:5555"
	m2 := inboundConnRe.FindStringSubmatch(line2)
	if m2 == nil || m2[3] != "from" || m2[4] != "1.2.3.4:5555" {
		t.Fatalf("from-line parse failed: %#v", m2)
	}
	// error/scan line must NOT match
	line3 := "ERROR[1] [2 0ms] inbound/shadowsocks[ss2022_wty]: process connection from 1.2.3.4:5: shadowsocks: bad header"
	if inboundConnRe.FindStringSubmatch(line3) != nil {
		t.Fatalf("scan/error line unexpectedly matched")
	}
}
