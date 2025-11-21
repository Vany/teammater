# Teammater - Twitch Stream Control
# Makefile for project management

.PHONY: serve stop status logs clean help

# Default target
help:
	@echo "Teammater Makefile - Available targets:"
	@echo ""
	@echo "  serve   - Start the Caddy web server (localhost:8443)"
	@echo "  stop    - Stop the Caddy web server"
	@echo "  status  - Check if Caddy is running"
	@echo "  logs    - Show Caddy logs"
	@echo "  clean   - Clean temporary files and caches"
	@echo "  help    - Show this help message"
	@echo ""
	@echo "Note: Requires Caddy web server to be installed"

serve:
	@echo "🚀 Starting Teammater web server..."
	@caddy start --config Caddyfile --pidfile .caddy.pid
	@echo "✅ Server running at https://localhost:8443"
	@echo "📝 PID file: .caddy.pid"

stop:
	@echo "🛑 Stopping Teammater web server..."
	@if [ -f .caddy.pid ]; then \
		caddy stop --config Caddyfile; \
		rm -f .caddy.pid; \
		echo "✅ Server stopped"; \
	else \
		echo "⚠️ Server not running (no PID file found)"; \
	fi

status:
	@if [ -f .caddy.pid ]; then \
		PID=$$(cat .caddy.pid); \
		if ps -p $$PID > /dev/null 2>&1; then \
			echo "✅ Teammater server is running (PID: $$PID)"; \
			echo "🌐 URL: https://localhost:8443"; \
		else \
			echo "❌ Server not running (stale PID file)"; \
			rm -f .caddy.pid; \
		fi \
	else \
		echo "❌ Server not running"; \
	fi

logs:
	@echo "📋 Checking Caddy logs..."
	@caddy list-adapters 2>/dev/null || echo "No active Caddy processes or logs available"

clean:
	@echo "🧹 Cleaning temporary files..."
	@rm -f .caddy.pid
	@echo "✅ Cleanup complete"

# Development targets
dev-info:
	@echo "🔧 Development Information:"
	@echo "  - Web server: Caddy (https://localhost:8443)"
	@echo "  - WebSocket: ws://localhost:8765 (minaret server)"
	@echo "  - Files: index.html, *.mp3 audio files"
	@echo "  - Config: Caddyfile, REQUIREMENTS.md"
