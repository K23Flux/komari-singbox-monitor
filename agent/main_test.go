package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseSingboxConfigDoesNotExposeSecrets(t *testing.T) {
	directory := t.TempDir()
	filename := filepath.Join(directory, "config.json")
	content := `{
  "inbounds": [
    {
      "type": "shadowsocks",
      "tag": "ss2022",
      "listen_port": 55101,
      "password": "main-secret",
      "users": [{"name":"LF","password":"user-secret"}]
    },
    {
      "type": "vless",
      "tag": "vless-in",
      "listen_port": 56679,
      "users": [{"name":"wujunjie","uuid":"secret-uuid"}]
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
	if inbounds[0].Port != 55101 || inbounds[0].Users[0] != "LF" {
		t.Fatalf("unexpected inbound: %#v", inbounds[0])
	}
	if inbounds[1].Port != 56679 || inbounds[1].Users[0] != "wujunjie" {
		t.Fatalf("unexpected inbound: %#v", inbounds[1])
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
		"sbm:upload:tcp:55101":   1000,
		"sbm:upload:udp:55101":   500,
		"sbm:download:tcp:55101": 2000,
		"sbm:download:udp:55101": 250,
	}
	updateTraffic(&state, raw, time.Unix(110, 0))
	value := state.Ports["55101"]
	if value.Upload.Total != 1500 || value.Download.Total != 2250 {
		t.Fatalf("unexpected totals: %#v", value)
	}
}
