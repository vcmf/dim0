# -------- Settings (tweak if needed) --------
PROFILE ?= dev                 # dev | local
ENVFILE ?= .env                # path to your env file (repo root by default)
DIM0_VERSION ?= $(shell cat VERSION)
COMPOSE_BASE := docker compose -p dim0-src -f build/docker-compose.yml
COMPOSE := ENVFILE=$(ENVFILE) $(COMPOSE_BASE) --env-file $(ENVFILE)
COMPOSE_IMAGES_BASE := docker compose -p dim0-images -f build/docker-compose.images.yml
COMPOSE_IMAGES := ENVFILE=$(ENVFILE) DIM0_VERSION=$(DIM0_VERSION) $(COMPOSE_IMAGES_BASE) --env-file $(ENVFILE)
DB_SERVICES := $(if $(filter prod,$(PROFILE)),postgres qdrant redis,postgres-$(PROFILE) qdrant-$(PROFILE) redis-$(PROFILE))

# Allow: make VAR=value ...
# Ex: make up PROFILE=local API_PORT=9090 API_HOST_PORT=9090 API_ORIGIN=http://localhost:9090

# -------- Meta --------
.PHONY: help
help: ## Show this help
	@awk 'BEGIN{FS=":.*##"; printf "\nTargets:\n"} /^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# -------- Core lifecycle --------
.PHONY: up
up: ## Build (if needed) + start all services for $(PROFILE)
	$(COMPOSE) --profile $(PROFILE) up -d

.PHONY: up-build
up-build: ## Force rebuild images, then start all services for $(PROFILE)
	$(COMPOSE) --profile $(PROFILE) up -d --build

.PHONY: build
build: ## Just (re)build images (no start)
	$(COMPOSE) --profile $(PROFILE) build

# ENVFILE reaches the webui build via npm_config_envfile, which its scripts read
# as `dotenv -e ../$npm_config_envfile`. Set it explicitly (not `npm --envfile=`,
# which leans on npm's unknown-flag→config passthrough) so it can't regress on a
# future npm; it then propagates through `tauri {dev,build}` → its before*Command.
# $(strip) drops the trailing spaces the ENVFILE default carries from its inline
# comment. ENVFILE must be repo-root-relative (the build prefixes `../`), same as
# the default `.env`; an absolute path won't resolve.
.PHONY: desktop-dev
desktop-dev: ## Run the Tauri desktop app in dev (native window + hot reload); needs Rust
	cd webui && npm_config_envfile="$(strip $(ENVFILE))" npm run tauri-dev

.PHONY: desktop-build
desktop-build: ## Build the desktop installer for this OS → webui/src-tauri/target/release/bundle
	cd webui && npm_config_envfile="$(strip $(ENVFILE))" npm run tauri-build

.PHONY: pull
pull: ## Pull published backend and webui images for DIM0_VERSION
	DIM0_VERSION=$(DIM0_VERSION) $(COMPOSE_IMAGES_BASE) pull backend webui

.PHONY: run
run: ## Run published images from Docker Hub using DIM0_VERSION
	$(COMPOSE_IMAGES) up -d

.PHONY: down-run
down-run: ## Stop published-image containers
	DIM0_VERSION=$(DIM0_VERSION) $(COMPOSE_IMAGES_BASE) down --remove-orphans

.PHONY: kill-run
kill-run: ## Stop published-image containers and remove volumes
	DIM0_VERSION=$(DIM0_VERSION) $(COMPOSE_IMAGES_BASE) down --volumes --remove-orphans

.PHONY: logs-run
logs-run: ## Tail logs for published-image services: make logs-run [SERVICE=backend]
	DIM0_VERSION=$(DIM0_VERSION) $(COMPOSE_IMAGES_BASE) logs -f --tail=200 $(SERVICE)

.PHONY: rebuild
rebuild: ## Rebuild without cache (no start)
	$(COMPOSE) --profile $(PROFILE) build --no-cache

.PHONY: down
down: ## Stop and remove containers (keep images & volumes)
	$(COMPOSE) --profile $(PROFILE) down --remove-orphans

.PHONY: kill
kill: ## Stop and remove containers, images, and volumes (⚠ wipes DB data)
	$(COMPOSE) --profile $(PROFILE) down --rmi all --volumes --remove-orphans

# -------- Visibility & debugging --------
.PHONY: ps
ps: ## Show containers status for $(PROFILE)
	$(COMPOSE) --profile $(PROFILE) ps

.PHONY: logs
logs: ## Tail logs for all $(PROFILE) services
	$(COMPOSE) --profile $(PROFILE) logs -f --tail=200

# Ex: make logs-s backend-dev
.PHONY: logs-s
logs-s: ## Tail logs for a single service: make logs-s SERVICE=backend-dev
	@test -n "$(SERVICE)" || (echo "Set SERVICE=..." && exit 1)
	$(COMPOSE) logs -f --tail=200 $(SERVICE)

# -------- Service-level controls --------
# Ex: make up-s SERVICE=backend-dev
.PHONY: up-s
up-s: ## Start one service (inherits $(PROFILE)); add --no-deps with NODEPS=1
	@test -n "$(SERVICE)" || (echo "Set SERVICE=..." && exit 1)
	$(COMPOSE) up -d $(if $(NODEPS),--no-deps,) $(SERVICE)

.PHONY: build-s
build-s: ## Build one service: make build-s SERVICE=webui-dev
	@test -n "$(SERVICE)" || (echo "Set SERVICE=..." && exit 1)
	$(COMPOSE) build $(SERVICE)

.PHONY: restart-s
restart-s: ## Restart one service: make restart-s SERVICE=backend-dev
	@test -n "$(SERVICE)" || (echo "Set SERVICE=..." && exit 1)
	$(COMPOSE) up -d --build $(SERVICE)

.PHONY: exec
exec: ## Exec into service shell: make exec SERVICE=backend-dev [CMD="bash"]
	@test -n "$(SERVICE)" || (echo "Set SERVICE=..." && exit 1)
	$(COMPOSE) exec $(SERVICE) $(if $(CMD),$(CMD),sh)

# -------- Handy shortcuts --------
.PHONY: up-backend
up-backend: ## Start only backend (no deps): make up-backend SERVICE=backend-dev
	@$(MAKE) up-s SERVICE=$(if $(SERVICE),$(SERVICE),backend-$(PROFILE)) NODEPS=1

.PHONY: up-webui
up-webui: ## Start only webui (no deps): make up-webui SERVICE=webui-dev
	@$(MAKE) up-s SERVICE=$(if $(SERVICE),$(SERVICE),webui-$(PROFILE)) NODEPS=1

.PHONY: up-db
up-db: ## Start only databases for $(PROFILE)
	$(COMPOSE) --profile $(PROFILE) up -d $(DB_SERVICES)

.PHONY: down-db
down-db: ## Stop DBs for $(PROFILE)
	$(COMPOSE) --profile $(PROFILE) stop $(DB_SERVICES)

# -------- Diagnostics --------
.PHONY: config
config: ## Show fully-resolved compose config (confirms env expansion)
	$(COMPOSE) config

.PHONY: prune
prune: ## Docker-wide cleanup (stopped containers, dangling images) - global
	docker system prune -f

.PHONY: version-sync
version-sync: ## Sync VERSION into backend, webui, and tauri manifests
	python3 scripts/sync_version.py

.PHONY: version-check
version-check: ## Check whether repo manifests match VERSION
	python3 scripts/sync_version.py --check

.PHONY: version-bump
version-bump: ## Bump repo version with commitizen (updates all manifests) and verify sync
	uv run --with commitizen cz bump
	python3 scripts/sync_version.py --check

# -------- CI / Tests --------
# Lightweight targets so GitHub Actions and local dev share one entry point.
# Backend integration tests require live DBs and live in test/integration/ —
# `test-backend` runs unit-only on purpose.
.PHONY: lint-ui
lint-ui: ## Webui type-check + eslint (check-all)
	cd webui && npm run check-all

.PHONY: test-ui
test-ui: ## Webui vitest suite (one-shot)
	cd webui && npm run test:run

.PHONY: lint-backend
lint-backend: ## Backend ruff check (runs before backend tests in CI)
	cd backend && uv run ruff check topix test/unit

.PHONY: setup-mini-app-compiler
setup-mini-app-compiler: ## Install mini-app compiler node deps (sucrase) for the compile-bridge tests
	@if [ ! -d backend/scripts/mini-app-compiler/node_modules ]; then \
		if command -v npm >/dev/null 2>&1; then \
			echo "Installing mini-app compiler deps (sucrase)…"; \
			cd backend/scripts/mini-app-compiler && npm ci --omit=dev; \
		else \
			echo "npm not found — skipping mini-app compiler deps; compile-bridge tests will skip"; \
		fi; \
	fi

.PHONY: test-backend
test-backend: setup-mini-app-compiler ## Backend unit tests (integration deferred — they need DBs)
	cd backend && uv run pytest test/unit

.PHONY: test-tauri
test-tauri: ## Desktop (Tauri) Rust unit tests — the rusqlite storage layer (needs Rust + WebKit/GTK)
	cd webui/src-tauri && cargo test

# `test-tauri` is intentionally NOT in `test-ci`: CI runs it as its own job, but a
# dev laptop may lack the Rust + libwebkit2gtk/gtk toolchain, and `make check`
# shouldn't fail there. Run `make test-tauri` explicitly when working on src-tauri.
.PHONY: test-ci
test-ci: lint-ui test-ui lint-backend test-backend ## Full CI suite: lint+test for webui then backend

.PHONY: check
check: test-ci ## Alias for test-ci — run every lint + test locally
