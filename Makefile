.PHONY: test build clean

test:
	cd agent && go test ./... && go vet ./...
	node --test tests/plugin.test.js

build:
	./build.sh

clean:
	rm -rf dist plugin/bin/sb-agent-linux-* plugin/bin/checksums.txt
