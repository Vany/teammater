# Teammater - Twitch Stream Control
# Makefile for project management
#
# The web server is the Rust binary in server/, NOT Caddy. Caddy was replaced
# and only `serve` was migrated at the time — stop/status/logs/clean still
# gated on a .caddy.pid file that nothing has written since, so `make stop`
# always claimed the server was not running while cargo kept holding :8443.
# Everything below now targets the cargo process.

.PHONY: serve stop status logs clean help dev-info

BIN := teammater-server
PORT := 8443

# Default target
help:
	@echo "Teammater Makefile - Available targets:"
	@echo ""
	@echo "  serve   - Build and run the Rust server (https://localhost:$(PORT))"
	@echo "  stop    - Stop the running server"
	@echo "  status  - Check whether the server is running"
	@echo "  logs    - Explain where logs go"
	@echo "  clean   - Remove Rust build artifacts"
	@echo "  help    - Show this help message"
	@echo ""
	@echo "Note: requires a Rust toolchain (cargo). Caddy is NOT used."

serve:
	cargo run --release --manifest-path=server/Cargo.toml

# Match on the listening port rather than a pid file: `cargo run` execs the
# binary as a child, so a pid we wrote would be the wrong process anyway.
stop:
	@echo "🛑 Stopping Teammater server..."
	@PIDS=$$(lsof -ti tcp:$(PORT) 2>/dev/null); \
	if [ -n "$$PIDS" ]; then \
		kill $$PIDS && echo "✅ Server stopped (pid: $$PIDS)"; \
	else \
		echo "⚠️ Nothing listening on port $(PORT)"; \
	fi

status:
	@PIDS=$$(lsof -ti tcp:$(PORT) 2>/dev/null); \
	if [ -n "$$PIDS" ]; then \
		echo "✅ Teammater server is running (pid: $$PIDS)"; \
		echo "🌐 URL: https://localhost:$(PORT)"; \
	else \
		echo "❌ Server not running (nothing on port $(PORT))"; \
	fi

logs:
	@echo "📋 The server logs to stdout via tracing — read them in the terminal"
	@echo "   running 'make serve'. Set RUST_LOG=debug for more detail."

clean:
	@echo "🧹 Cleaning Rust build artifacts..."
	@cargo clean --manifest-path=server/Cargo.toml
	@echo "✅ Cleanup complete"

# Development targets
dev-info:
	@echo "🔧 Development Information:"
	@echo "  - Web server: Rust (server/), https://localhost:$(PORT), http :8442"
	@echo "  - WebSocket: ws://localhost:8765 (minaret server)"
	@echo "  - Files: index.html, obs.html, mobile.html, *.mp3 audio files"
	@echo "  - Docs: SPEC.md, MEMO.md, TODO.md, REQUIREMENTS.md"
