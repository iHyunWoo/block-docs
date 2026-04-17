.PHONY: help up down restart clean logs ps seed test test-api test-ws test-e2e install build fmt

SHELL := /bin/bash
COMPOSE := docker compose -f infra/docker-compose.yml
COMPOSE_DEV := $(COMPOSE) -f infra/docker-compose.dev.yml

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies for all apps
	cd apps/api && python -m venv .venv && .venv/bin/pip install -r requirements.txt
	cd apps/ws && npm install
	cd apps/web && npm install
	cd tests/e2e && npm install

up: ## Start full stack (postgres + redis + api + ws x2 + web x2) with hot reload
	$(COMPOSE_DEV) up -d --build
	@echo ""
	@echo "Stack is starting. URLs:"
	@echo "  web-1:    http://localhost:3001"
	@echo "  web-2:    http://localhost:3002"
	@echo "  ws-1:     ws://localhost:4001"
	@echo "  ws-2:     ws://localhost:4002"
	@echo "  api:      http://localhost:8000 (docs: /docs)"
	@echo "  postgres: localhost:5432 (blockdocs/blockdocs/blockdocs)"
	@echo "  redis:    localhost:6379"
	@echo ""
	@echo "Run 'make logs' to follow all logs, 'make seed' to insert demo data."

down: ## Stop stack (keep volumes)
	$(COMPOSE_DEV) down

restart: ## Restart stack
	$(COMPOSE_DEV) restart

clean: ## Stop and remove all data (postgres + redis volumes)
	$(COMPOSE_DEV) down -v

logs: ## Follow all service logs
	$(COMPOSE_DEV) logs -f

logs-%: ## Follow logs for a single service (e.g. make logs-api)
	$(COMPOSE_DEV) logs -f $*

ps: ## Show running services
	$(COMPOSE_DEV) ps

seed: ## Insert a demo document and users
	$(COMPOSE_DEV) exec api python -m app.scripts.seed

psql: ## Open psql shell
	$(COMPOSE_DEV) exec postgres psql -U blockdocs -d blockdocs

redis-cli: ## Open redis-cli
	$(COMPOSE_DEV) exec redis redis-cli

test: test-api test-ws test-e2e ## Run all tests

test-api: ## Run API tests (pytest)
	cd apps/api && .venv/bin/pytest -v

test-ws: ## Run WS tests (vitest)
	cd apps/ws && npm test

test-e2e: ## Run E2E tests (Playwright)
	cd tests/e2e && npm test

build: ## Build all docker images (prod)
	$(COMPOSE) build

fmt: ## Format all code
	cd apps/api && .venv/bin/ruff format .
	cd apps/ws && npm run fmt
	cd apps/web && npm run fmt
