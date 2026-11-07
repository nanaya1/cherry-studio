// electron.vite.config.ts
import { readdirSync, readFileSync } from "fs";
import { join, resolve as resolve3 } from "path";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { CodeInspectorPlugin } from "code-inspector-plugin";
import { defineConfig } from "electron-vite";
import { visualizer } from "rollup-plugin-visualizer";
import { parse } from "yaml";

// package.json
var package_default = {
  name: "MEACowork",
  version: "2.1.4",
  private: true,
  description: "A powerful AI assistant for producer.",
  author: "mkt@xuelangyun.com",
  main: "./out/main/main.js",
  scripts: {
    "analyze:main": "VISUALIZER_MAIN=true pnpm build",
    "analyze:renderer": "VISUALIZER_RENDERER=true pnpm build",
    bench: "vitest bench --run",
    "bench:aicore": 'vitest bench --run --project "aiCore (bench)"',
    "bench:main": 'vitest bench --run --project "main (bench)"',
    "bench:renderer": 'vitest bench --run --project "renderer (bench)"',
    "bench:shared": 'vitest bench --run --project "shared (bench)"',
    build: "pnpm run typecheck && dotenv -v CHERRY_EDITION=global -- electron-vite build && pnpm run build:utility-process",
    "build:builtin-knowledge": "tsx scripts/generate-cherry-assistant-knowledge",
    "build:builtin-knowledge:check": "tsx scripts/generate-cherry-assistant-knowledge --check",
    "build:check": "pnpm lint && pnpm docs:check && pnpm test",
    "build:cn": "pnpm run typecheck && dotenv -v CHERRY_EDITION=cn -- electron-vite build && pnpm run build:utility-process",
    "build:linux": "dotenv pnpm run build && electron-builder --linux --x64 --arm64",
    "build:linux:arm64": "dotenv pnpm run build && electron-builder --linux --arm64",
    "build:linux:arm64:cn": "pnpm run build:cn && electron-builder --config electron-builder.cn.config.cjs --linux --arm64",
    "build:linux:cn": "pnpm run build:cn && electron-builder --config electron-builder.cn.config.cjs --linux --x64 --arm64",
    "build:linux:x64": "dotenv pnpm run build && electron-builder --linux --x64",
    "build:linux:x64:cn": "pnpm run build:cn && electron-builder --config electron-builder.cn.config.cjs --linux --x64",
    "build:mac": "dotenv pnpm run build && electron-builder --mac --arm64 --x64",
    "build:mac:arm64": "dotenv pnpm run build && electron-builder --mac --arm64",
    "build:mac:arm64:cn": "pnpm run build:cn && electron-builder --config electron-builder.cn.config.cjs --mac --arm64",
    "build:mac:cn": "pnpm run build:cn && electron-builder --config electron-builder.cn.config.cjs --mac --arm64 --x64",
    "build:mac:x64": "dotenv pnpm run build && electron-builder --mac --x64",
    "build:mac:x64:cn": "pnpm run build:cn && electron-builder --config electron-builder.cn.config.cjs --mac --x64",
    "build:unpack": "dotenv pnpm run build && electron-builder --dir",
    "build:unpack:cn": "pnpm run build:cn && electron-builder --config electron-builder.cn.config.cjs --dir",
    "build:utility-process": "electron-vite build --config electron.vite.entries.config.ts",
    "build:win": "dotenv pnpm run build && electron-builder --win --x64 --arm64",
    "build:win:arm64": "dotenv pnpm run build && electron-builder --win --arm64",
    "build:win:arm64:cn": "pnpm run build:cn && electron-builder --config electron-builder.cn.config.cjs --win --arm64",
    "build:win:cn": "pnpm run build:cn && electron-builder --config electron-builder.cn.config.cjs --win --x64 --arm64",
    "build:win:x64": "dotenv pnpm run build && electron-builder --win --x64",
    "build:win:x64:cn": "pnpm run build:cn && electron-builder --config electron-builder.cn.config.cjs --win --x64",
    changeset: "changeset",
    "changeset:publish": "changeset publish",
    "changeset:status": "changeset status",
    "changeset:version": "changeset version && pnpm format",
    ci: "pnpm ci:basic-check && pnpm ci:test-check",
    "ci:basic-check": "pnpm mea:check && pnpm test:lint && pnpm format:check && pnpm typecheck && pnpm i18n:check && pnpm i18n:unused:check && pnpm i18n:hardcoded:strict && pnpm skills:check && pnpm docs:check",
    "ci:test-check": "pnpm test:main && pnpm test:renderer && pnpm test:aicore && pnpm test:shared && pnpm test:provider-registry && pnpm test:scripts && pnpm --filter @cherrystudio/remote-protocol test && pnpm --filter @cherrystudio/remote-transport test",
    claude: "dotenv -e .env -- claude",
    "data:generate": "node scripts/data-classify/scripts/generate-all.js",
    "db:migrations:check": "drizzle-kit check --config ./migrations/sqlite-drizzle.config.ts",
    "db:migrations:generate": "drizzle-kit generate --config ./migrations/sqlite-drizzle.config.ts",
    debug: "pnpm rebuild:electron && pnpm download:binaries && pnpm run build:utility-process && dotenv -- electron-vite -- --inspect --sourcemap --remote-debugging-port=9222",
    dev: "pnpm rebuild:electron && pnpm download:binaries && pnpm run build:utility-process && dotenv electron-vite dev",
    "dev:cn": "dotenv -v CHERRY_EDITION=cn -- pnpm dev",
    "dev:watch": "pnpm rebuild:electron && pnpm download:binaries && pnpm run build:utility-process && dotenv electron-vite dev -- -w",
    "docs:check": "pnpm docs:check-links && pnpm docs:check-structure && pnpm docs:check-frontmatter && pnpm docs:check-index",
    "docs:check-frontmatter": "tsx scripts/verify-doc-frontmatter.ts",
    "docs:check-index": "tsx scripts/gen-doc-index.ts --check",
    "docs:check-links": "tsx scripts/check-doc-links.ts",
    "docs:check-structure": "tsx scripts/verify-doc-structure.ts",
    "docs:index": "tsx scripts/gen-doc-index.ts",
    "download:binaries": "node scripts/download-binaries.js",
    format: "oxfmt --write .",
    "format:check": "oxfmt --check .",
    "gen:system-provider-ids": "tsx scripts/generate-system-provider-ids.ts",
    "i18n:check": "dotenv -e .env -- tsx scripts/i18n-check.ts",
    "i18n:extract": "i18next-cli extract",
    "i18n:hardcoded": "tsx scripts/i18n-check-hardcoded-strings.ts",
    "i18n:hardcoded:strict": "cross-env I18N_STRICT=true tsx scripts/i18n-check-hardcoded-strings.ts",
    "i18n:lint": "i18next-cli lint",
    "i18n:remove-unused": "tsx scripts/i18n-check-unused.ts --clean",
    "i18n:sync": "dotenv -e .env -- tsx scripts/i18n-sync.ts",
    "i18n:unused": "tsx scripts/i18n-check-unused.ts",
    "i18n:unused:check": "tsx scripts/i18n-check-unused.ts --fail-on-unused",
    lint: "oxlint --fix && eslint . --ext .js,.jsx,.cjs,.mjs,.ts,.tsx,.cts,.mts --fix --cache && pnpm typecheck && pnpm i18n:check && pnpm format",
    "mea:check": "tsx scripts/check-mea-customizations.ts",
    "mea:impact": "tsx scripts/check-mea-customizations.ts",
    "packages:build": "pnpm --filter @cherrystudio/ai-sdk-provider build && pnpm --filter @cherrystudio/ai-core build && pnpm --filter @cherrystudio/extension-table-plus build && pnpm --filter @cherrystudio/remote-protocol build && pnpm --filter @cherrystudio/remote-transport build",
    "packages:release": "pnpm packages:build && changeset publish",
    postinstall: "pnpm --filter @cherrystudio/dsh-bridge build && pnpm --filter @cherrystudio/remote-protocol build && pnpm --filter @cherrystudio/remote-transport build",
    prepare: `git config blame.ignoreRevsFile .git-blame-ignore-revs && node -e "process.env.CI||require('child_process').execSync('prek install',{stdio:'inherit'})"`,
    pretest: "pnpm rebuild:node",
    "pretest:main": "pnpm rebuild:node",
    "rebuild:electron": "install-electron && electron-rebuild --force --only better-sqlite3",
    "rebuild:node": "node scripts/invalidate-electron-rebuild-metadata.js && pnpm rebuild better-sqlite3",
    "skills:check": "tsx scripts/skills-check.ts",
    "skills:sync": "tsx scripts/skills-sync.ts",
    "smoke:dsh-runtime": "cross-env CHERRY_DSH_SMOKE=1 vitest run --project main src/main/ai/runtime/dsh/__tests__/bunRuntime.smoke.test.ts",
    "smoke:utility-process": "tsx scripts/utility-process-smoke/run.ts",
    start: "pnpm rebuild:electron && electron-vite preview",
    "start:cn": "dotenv -v CHERRY_EDITION=cn -- pnpm start",
    "styles:canonical": "tsx scripts/fix-tailwind-canonical-classes.ts",
    test: "vitest run --silent --project main && vitest run --silent --project renderer && vitest run --silent --project aiCore --project ui --project shared --project provider-registry --project scripts --project preload",
    "test:aicore": "vitest run --project aiCore",
    "test:coverage": "vitest run --coverage --silent",
    "test:e2e": "pnpm playwright test",
    "test:e2e:regression": "pnpm playwright test --config playwright.regression.config.ts",
    "test:lint": "oxlint --deny-warnings && eslint . --ext .js,.jsx,.cjs,.mjs,.ts,.tsx,.cts,.mts --cache",
    "test:main": "vitest run --project main",
    "test:pkg:ui": "vitest run --project ui",
    "test:preload": "vitest run --project preload",
    "test:provider-registry": "vitest run --project provider-registry",
    "test:renderer": "vitest run --project renderer",
    "test:scripts": "vitest scripts",
    "test:shared": "vitest run --project shared",
    "test:ui": "vitest --ui",
    "test:update": "pnpm test:renderer --update",
    "test:watch": "vitest",
    typecheck: 'pnpm --filter @cherrystudio/ai-sdk-provider build && concurrently -n "node,web,aicore,e2e" -c "cyan,magenta,yellow,blue" "pnpm run typecheck:node" "pnpm run typecheck:web" "pnpm --filter @cherrystudio/ai-core typecheck" "pnpm run typecheck:e2e"',
    "typecheck:e2e": "tsc --noEmit -p tsconfig.e2e.json",
    "typecheck:node": "tsc --noEmit -p tsconfig.node.json --composite false",
    "typecheck:web": "tsc --noEmit -p tsconfig.web.json --composite false",
    "ui:contract:query": "tsx scripts/uiContract/query.ts",
    "update:languages": "tsx scripts/update-languages.ts"
  },
  dependencies: {
    "@anthropic-ai/claude-agent-sdk": "0.3.284",
    "@cherrystudio/dsh-bridge": "workspace:*",
    "@cherrystudio/remote-protocol": "workspace:*",
    "@cherrystudio/remote-transport": "workspace:*",
    "@deepseek-ai/dsh-sdk-client": "0.2.0-rc.2",
    "@deepseek-ai/dsh-sdk-protocol": "0.2.0-rc.2",
    "@earendil-works/pi-ai": "0.80.6",
    "@earendil-works/pi-coding-agent": "0.80.3",
    "@firecrawl/anydoc": "0.1.3",
    "@huggingface/transformers": "4.2.0",
    "@larksuiteoapi/node-sdk": "^1.73.0",
    "@napi-rs/canvas": "0.1.80",
    "@napi-rs/system-ocr": "1.2.0",
    "@node-rs/xxhash": "1.7.6",
    "@paymoapp/electron-shutdown-handler": "1.2.0",
    "@sentry/electron": "7.18.0",
    "@vectorstores/core": "^0.1.8",
    "@vectorstores/env": "^0.1.0",
    "@vectorstores/readers": "^0.1.8",
    "better-sqlite3": "12.11.1",
    "cross-spawn": "7.0.6",
    "dingtalk-stream": "2.1.5",
    "font-list": "2.0.0",
    "graceful-fs": "4.2.11",
    grammy: "^1.36.3",
    "gray-matter": "4.0.3",
    jsdom: "26.1.0",
    "node-screenshots": "^0.2.8",
    "node-stream-zip": "1.15.0",
    officeparser: "4.2.0",
    "onnxruntime-common": "1.25.1",
    "onnxruntime-node": "1.25.1",
    "os-proxy-config": "1.1.2",
    "pdf-parse": "^2.4.5",
    "pdfjs-dist": "5.4.296",
    "ppu-paddle-ocr": "6.0.0",
    "registry-js": "1.16.1",
    "selection-hook": "2.1.1",
    sharp: "0.35.3",
    "smol-toml": "^1.7.0",
    "sqlite-vec": "npm:@aiany/sqlite-vec@0.1.10-alpha.4.aiany.2",
    systeminformation: "5.33.8",
    tar: "^7.5.11",
    "tesseract.js": "6.0.1",
    turndown: "7.2.0",
    which: "6.0.1",
    ws: "^8.21.0"
  },
  devDependencies: {
    "@ai-sdk/amazon-bedrock": "^4.0.96",
    "@ai-sdk/anthropic": "^3.0.125",
    "@ai-sdk/azure": "^3.0.116",
    "@ai-sdk/bytedance": "1.0.29",
    "@ai-sdk/cerebras": "^2.0.78",
    "@ai-sdk/cohere": "^3.0.30",
    "@ai-sdk/devtools": "^0.0.17",
    "@ai-sdk/gateway": "^3.0.104",
    "@ai-sdk/google": "3.0.113",
    "@ai-sdk/google-vertex": "^4.0.188",
    "@ai-sdk/groq": "^3.0.35",
    "@ai-sdk/huggingface": "^1.0.74",
    "@ai-sdk/mistral": "^3.0.30",
    "@ai-sdk/open-responses": "1.0.34",
    "@ai-sdk/openai": "^3.0.109",
    "@ai-sdk/openai-compatible": "2.0.72",
    "@ai-sdk/perplexity": "^3.0.29",
    "@ai-sdk/provider": "^3.0.15",
    "@ai-sdk/provider-utils": "^4.0.48",
    "@ai-sdk/react": "^3.0.147",
    "@ai-sdk/test-server": "^1.0.3",
    "@ai-sdk/togetherai": "^2.0.78",
    "@ai-sdk/xai": "^3.0.126",
    "@aiden0z/pptx-renderer": "1.2.2",
    "@anthropic-ai/sdk": "^0.93.0",
    "@aws-sdk/client-s3": "^3.998.0",
    "@aws-sdk/lib-storage": "3.998.0",
    "@babel/runtime": "^7.29.7",
    "@changesets/changelog-github": "^0.5.2",
    "@changesets/cli": "^2.29.8",
    "@cherrystudio/ai-core": "workspace:*",
    "@cherrystudio/analytics-client": "1.4.0",
    "@cherrystudio/extension-table-plus": "workspace:^",
    "@cherrystudio/openai": "6.15.0",
    "@cherrystudio/provider-registry": "workspace:*",
    "@cherrystudio/remote-protocol-v0": "npm:@cherrystudio/remote-protocol@0.1.0",
    "@cherrystudio/ui": "workspace:*",
    "@codemirror/lang-json": "6.0.2",
    "@codemirror/language": "6.12.2",
    "@codemirror/lint": "6.9.5",
    "@codemirror/view": "6.39.16",
    "@dagrejs/dagre": "^3.0.0",
    "@deepseek-ai/dsh-compaction-basic": "0.2.0-rc.2",
    "@deepseek-ai/dsh-goal": "0.2.0-rc.2",
    "@deepseek-ai/dsh-llm": "0.2.0-rc.2",
    "@deepseek-ai/dsh-llm-retry": "0.2.0-rc.2",
    "@deepseek-ai/dsh-plan-mode": "0.2.0-rc.2",
    "@deepseek-ai/dsh-session": "0.2.0-rc.2",
    "@deepseek-ai/dsh-user-approval": "0.2.0-rc.2",
    "@dnd-kit/core": "^6.3.1",
    "@dnd-kit/modifiers": "^9.0.0",
    "@dnd-kit/sortable": "^10.0.0",
    "@dnd-kit/utilities": "^3.2.2",
    "@e965/xlsx": "^0.20.3",
    "@electron-toolkit/eslint-config-ts": "^3.0.0",
    "@electron-toolkit/preload": "^3.0.0",
    "@electron-toolkit/utils": "^3.0.0",
    "@electron/asar": "3.4.1",
    "@electron/notarize": "^2.5.0",
    "@electron/rebuild": "^4.0.4",
    "@elysia/bearer": "^1.4.4",
    "@elysia/cors": "^1.4.2",
    "@elysia/node": "^1.4.6",
    "@elysia/openapi": "^1.4.15",
    "@eslint-react/eslint-plugin": "^1.36.1",
    "@eslint/js": "^9.22.0",
    "@floating-ui/dom": "1.7.3",
    "@fontsource/ubuntu": "5.2.8",
    "@google/genai": "^1.46.0",
    "@hello-pangea/dnd": "^18.0.1",
    "@hookform/resolvers": "^5.0.1",
    "@iconify-json/material-icon-theme": "^1.2.56",
    "@iconify/react": "^6.0.2",
    "@j178/prek": "^0.3.4",
    "@lezer/highlight": "1.2.3",
    "@mistralai/mistralai": "^1.7.5",
    "@modelcontextprotocol/sdk": "1.29.0",
    "@mozilla/readability": "^0.6.0",
    "@notionhq/client": "^2.2.15",
    "@openrouter/ai-sdk-provider": "^2.10.0",
    "@opentelemetry/api": "1.9.1",
    "@opentelemetry/context-async-hooks": "2.0.1",
    "@opentelemetry/core": "2.0.0",
    "@opentelemetry/exporter-trace-otlp-http": "^0.200.0",
    "@opentelemetry/sdk-trace-base": "^2.0.0",
    "@opentelemetry/sdk-trace-node": "^2.0.0",
    "@opeoginni/github-copilot-openai-compatible": "^1.0.0",
    "@paddleocr/api-sdk": "^0.2.0",
    "@pierre/diffs": "^1.1.3",
    "@playwright/test": "^1.62.1",
    "@radix-ui/react-context-menu": "^2.3.3",
    "@radix-ui/react-slot": "^1.2.4",
    "@radix-ui/react-switch": "^1.2.6",
    "@sentry/vite-plugin": "5.4.0",
    "@shikijs/markdown-it": "^3.12.0",
    "@tailwindcss/vite": "^4.3.3",
    "@tanstack/react-router": "^1.170.18",
    "@tanstack/react-virtual": "^3.13.24",
    "@tanstack/router-plugin": "^1.168.23",
    "@testing-library/dom": "^10.4.0",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.1",
    "@tiptap/core": "3.26.1",
    "@tiptap/extension-code-block": "3.26.1",
    "@tiptap/extension-collaboration": "3.26.1",
    "@tiptap/extension-drag-handle": "3.26.1",
    "@tiptap/extension-drag-handle-react": "3.26.1",
    "@tiptap/extension-heading": "3.26.1",
    "@tiptap/extension-image": "3.26.1",
    "@tiptap/extension-link": "3.26.1",
    "@tiptap/extension-list": "3.26.1",
    "@tiptap/extension-mathematics": "3.26.1",
    "@tiptap/extension-mention": "3.26.1",
    "@tiptap/extension-node-range": "3.26.1",
    "@tiptap/extension-table-of-contents": "3.26.1",
    "@tiptap/extension-typography": "3.26.1",
    "@tiptap/extension-underline": "3.26.1",
    "@tiptap/markdown": "3.26.1",
    "@tiptap/pm": "3.26.1",
    "@tiptap/react": "3.26.1",
    "@tiptap/starter-kit": "3.26.1",
    "@tiptap/suggestion": "3.26.1",
    "@tiptap/y-tiptap": "^3.0.5",
    "@tryfabric/martian": "^1.2.4",
    "@types/adm-zip": "^0.5.7",
    "@types/better-sqlite3": "^7.6.13",
    "@types/cli-progress": "^3",
    "@types/cross-spawn": "6.0.6",
    "@types/diff": "^7",
    "@types/fs-extra": "^11",
    "@types/hast": "^3.0.4",
    "@types/html-to-text": "^9",
    "@types/json-schema": "7.0.15",
    "@types/markdown-it": "^14",
    "@types/md5": "^2.3.5",
    "@types/mdast": "4.0.4",
    "@types/mime-types": "^3",
    "@types/node": "24.10.4",
    "@types/pako": "^1.0.2",
    "@types/qrcode": "^1.5.6",
    "@types/react": "^19.2.7",
    "@types/react-dom": "^19.2.3",
    "@types/react-transition-group": "^4.4.12",
    "@types/react-window": "^1",
    "@types/semver": "^7.7.1",
    "@types/stream-json": "^1",
    "@types/tinycolor2": "^1",
    "@types/turndown": "^5.0.5",
    "@types/unist": "3.0.3",
    "@types/use-sync-external-store": "^0.0.6",
    "@types/uuid": "^10.0.0",
    "@types/which": "3.0.4",
    "@types/word-extractor": "^1",
    "@types/ws": "^8.18.1",
    "@typescript/native": "npm:typescript@7.0.2",
    "@typescript/typescript6": "6.0.2",
    "@uiw/codemirror-extensions-langs": "4.25.7",
    "@uiw/codemirror-themes-all": "4.25.7",
    "@uiw/react-codemirror": "4.25.7",
    "@vitejs/plugin-react": "6.0.5",
    "@vitest/browser": "^5.0.1",
    "@vitest/coverage-v8": "^5.0.1",
    "@vitest/ui": "^5.0.1",
    "@vitest/web-worker": "^5.0.1",
    "@viz-js/lang-dot": "^1.0.5",
    "@viz-js/viz": "^3.14.0",
    "@xyflow/react": "^12.4.4",
    "adm-zip": "0.4.16",
    ai: "6.0.185",
    "ai-retry": "^1.11.0",
    "ansi-to-react": "^6.2.6",
    archiver: "^8.0.0",
    "async-mutex": "^0.5.0",
    axios: "^1.16.0",
    "bonjour-service": "1.3.0",
    "builder-util-runtime": "9.5.0",
    chalk: "4.1.2",
    chardet: "^2.1.0",
    cheerio: "^1.1.2",
    chokidar: "^4.0.3",
    "cli-progress": "^3.12.0",
    clsx: "^2.1.1",
    "code-inspector-plugin": "^0.20.14",
    "codemirror-lang-mermaid": "0.5.0",
    color: "^5.0.0",
    commander: "^14.0.2",
    concurrently: "^9.2.1",
    "country-flag-emoji-polyfill": "0.1.8",
    croner: "^10.0.1",
    "cross-env": "^10.1.0",
    dayjs: "^1.11.11",
    "devtools-protocol": "0.0.1692173",
    dexie: "^4.0.8",
    diff: "^8.0.3",
    docx: "^9.0.2",
    "docx-preview": "0.3.7",
    dompurify: "^3.2.6",
    dotenv: "16.6.1",
    "dotenv-cli": "^7.4.2",
    "drizzle-kit": "^0.31.4",
    "drizzle-orm": "^0.44.5",
    echarts: "^6.1.0",
    electron: "44.2.0",
    "electron-builder": "26.15.6",
    "electron-devtools-installer": "^3.2.0",
    "electron-reload": "^2.0.0-alpha.1",
    "electron-store": "^8.2.0",
    "electron-updater": "6.7.0",
    "electron-vite": "6.0.0-beta.1",
    elysia: "^1.4.28",
    emittery: "^1.0.3",
    "emoji-picker-element-data": "1.8.0",
    "emoji-picker-react": "^4.19.1",
    epub: "2.1.1",
    "es-toolkit": "^1.49.0",
    eslint: "^9.22.0",
    "eslint-import-resolver-typescript": "^4.4.5",
    "eslint-plugin-import-x": "^4.17.1",
    "eslint-plugin-import-zod": "^1.2.0",
    "eslint-plugin-oxlint": "^1.15.0",
    "eslint-plugin-react-hooks": "^5.2.0",
    "eslint-plugin-simple-import-sort": "^12.1.1",
    "eslint-plugin-unused-imports": "^4.1.4",
    exceljs: "^4.4.0",
    "fast-diff": "^1.3.0",
    "fast-formula-parser": "^1.0.19",
    "fast-xml-parser": "5.5.6",
    "fetch-socks": "1.3.2",
    "file-type": "22.0.1",
    "fractional-indexing": "^3.2.0",
    "franc-min": "^6.2.0",
    "fs-extra": "^11.2.0",
    "google-auth-library": "^9.15.1",
    "gpt-tokenizer": "^3.4.0",
    "html-to-image": "^1.11.13",
    "html-to-text": "^9.0.5",
    htmlparser2: "^10.0.0",
    "http-proxy-agent": "^7.0.2",
    "https-proxy-agent": "^7.0.6",
    i18next: "^23.11.5",
    "i18next-cli": "^1.64.1",
    "i18next-resources-to-backend": "^1.2.1",
    "iconv-lite": "^0.6.3",
    ignore: "^7.0.5",
    "ipaddr.js": "^2.2.0",
    isbinaryfile: "5.0.4",
    jaison: "^2.0.2",
    "js-base64": "3.7.7",
    "json-schema": "0.4.0",
    "jsonc-parser": "^3.3.1",
    jszip: "^3.10.1",
    katex: "0.16.22",
    ky: "1.8.1",
    "linguist-languages": "^8.1.0",
    "lru-cache": "^11.1.0",
    "lucide-react": "^0.525.0",
    "macos-release": "^3.4.0",
    "magic-string": "0.30.21",
    "markdown-it": "^14.1.1",
    md5: "2.3.0",
    "mdast-util-from-markdown": "^2.0.2",
    mermaid: "^11.13.0",
    "micromark-util-types": "^2.0.2",
    mime: "^4.0.4",
    "mime-types": "^3.0.1",
    motion: "^12.42.0",
    nanoid: "3.3.11",
    "notion-helper": "^1.3.22",
    "npx-scope-finder": "^1.2.0",
    numfmt: "^3.2.6",
    "og-crd": "^0.0.2",
    "ollama-ai-provider-v2": "3.3.1",
    open: "^8.4.2",
    "oxc-parser": "0.142.0",
    oxfmt: "0.61.0",
    oxlint: "1.76.0",
    "oxlint-tsgolint": "7.0.2001",
    "p-queue": "^8.1.0",
    pako: "1.0.11",
    "partial-json": "0.1.7",
    "pdf-lib": "^1.17.1",
    postcss: "8.5.6",
    qrcode: "^1.5.4",
    "qrcode.react": "^4.2.0",
    "rc-input": "1.8.0",
    "rc-select": "14.16.6",
    "rc-virtual-list": "3.18.6",
    react: "^19.2.0",
    "react-dom": "^19.2.0",
    "react-error-boundary": "^6.0.0",
    "react-hook-form": "^7.55.0",
    "react-hotkeys-hook": "^4.6.1",
    "react-i18next": "^14.1.2",
    "react-player": "^3.3.1",
    "react-spinners": "^0.14.1",
    "react-transition-group": "^4.4.5",
    "reflect-metadata": "0.2.2",
    "rehype-parse": "^9.0.1",
    "rehype-stringify": "^10.0.1",
    "remark-gfm": "^4.0.1",
    "remark-github-blockquote-alert": "^2.0.0",
    "remark-parse": "11.0.0",
    "remark-stringify": "11.0.0",
    "remove-markdown": "^0.6.2",
    "rollup-plugin-visualizer": "^5.12.0",
    semver: "7.7.1",
    shiki: "^3.12.0",
    "socks-proxy-agent": "^8.0.5",
    "stream-json": "^1.9.1",
    streamdown: "^2.5.0",
    "strict-url-sanitise": "^0.0.1",
    "string-width": "^7.2.0",
    swr: "^2.3.6",
    "tailwind-merge": "^3.3.1",
    tailwindcss: "^4.3.3",
    "telegram-markdown-v2": "^0.0.4",
    "tiny-pinyin": "^1.3.2",
    tokenx: "^1.1.0",
    "ts-morph": "^27.0.2",
    tsx: "^4.20.3",
    "turndown-plugin-gfm": "^1.0.2",
    "tw-animate-css": "^1.3.8",
    typescript: "5.9.3",
    undici: "6.27.0",
    unified: "^11.0.5",
    "unist-util-visit": "5.0.0",
    "use-sync-external-store": "^1.6.0",
    uuid: "^13.0.0",
    virtua: "^0.49.1",
    vite: "8.2.2",
    vitest: "^5.0.1",
    "voyage-ai-provider": "^3.0.0",
    webdav: "^5.9.0",
    winston: "^3.17.0",
    "winston-daily-rotate-file": "^5.0.0",
    "word-extractor": "^1.0.4",
    "y-protocols": "^1.0.6",
    yaml: "^2.8.1",
    yjs: "^13.6.27",
    "youtubei.js": "^15.0.1",
    zipread: "^1.3.3",
    zod: "^4.1.5"
  },
  optionalDependencies: {
    "@aiany/sqlite-vec-darwin-arm64": "0.1.10-alpha.4.aiany.2",
    "@aiany/sqlite-vec-darwin-x64": "0.1.10-alpha.4.aiany.2",
    "@aiany/sqlite-vec-linux-arm64": "0.1.10-alpha.4.aiany.2",
    "@aiany/sqlite-vec-linux-x64": "0.1.10-alpha.4.aiany.2",
    "@aiany/sqlite-vec-windows-arm64": "0.1.10-alpha.4.aiany.2",
    "@aiany/sqlite-vec-windows-x64": "0.1.10-alpha.4.aiany.2",
    "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.284",
    "@anthropic-ai/claude-agent-sdk-darwin-x64": "0.3.284",
    "@anthropic-ai/claude-agent-sdk-linux-arm64": "0.3.284",
    "@anthropic-ai/claude-agent-sdk-linux-arm64-musl": "0.3.284",
    "@anthropic-ai/claude-agent-sdk-linux-x64": "0.3.284",
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl": "0.3.284",
    "@anthropic-ai/claude-agent-sdk-win32-arm64": "0.3.284",
    "@anthropic-ai/claude-agent-sdk-win32-x64": "0.3.284",
    "@deepseek-ai/node-addon-system-darwin-arm64": "0.1.2",
    "@deepseek-ai/node-addon-system-darwin-x64": "0.1.2",
    "@deepseek-ai/node-addon-system-linux-arm64": "0.1.2",
    "@deepseek-ai/node-addon-system-linux-x64": "0.1.2",
    "@firecrawl/anydoc-darwin-arm64": "0.1.3",
    "@firecrawl/anydoc-darwin-x64": "0.1.3",
    "@firecrawl/anydoc-linux-arm64-gnu": "0.1.3",
    "@firecrawl/anydoc-linux-arm64-musl": "0.1.3",
    "@firecrawl/anydoc-linux-x64-gnu": "0.1.3",
    "@firecrawl/anydoc-linux-x64-musl": "0.1.3",
    "@firecrawl/anydoc-win32-x64-msvc": "0.1.3",
    "@img/sharp-darwin-arm64": "0.35.3",
    "@img/sharp-darwin-x64": "0.35.3",
    "@img/sharp-libvips-darwin-arm64": "1.3.2",
    "@img/sharp-libvips-darwin-x64": "1.3.2",
    "@img/sharp-libvips-linux-arm64": "1.3.2",
    "@img/sharp-libvips-linux-x64": "1.3.2",
    "@img/sharp-libvips-linuxmusl-arm64": "1.3.2",
    "@img/sharp-libvips-linuxmusl-x64": "1.3.2",
    "@img/sharp-linux-arm64": "0.35.3",
    "@img/sharp-linux-x64": "0.35.3",
    "@img/sharp-linuxmusl-arm64": "0.35.3",
    "@img/sharp-linuxmusl-x64": "0.35.3",
    "@img/sharp-win32-arm64": "0.35.3",
    "@img/sharp-win32-x64": "0.35.3",
    "@napi-rs/canvas-darwin-arm64": "0.1.97",
    "@napi-rs/canvas-darwin-x64": "0.1.97",
    "@napi-rs/canvas-linux-arm64-gnu": "0.1.97",
    "@napi-rs/canvas-linux-arm64-musl": "0.1.97",
    "@napi-rs/canvas-linux-x64-gnu": "0.1.97",
    "@napi-rs/canvas-linux-x64-musl": "0.1.97",
    "@napi-rs/canvas-win32-arm64-msvc": "0.1.97",
    "@napi-rs/canvas-win32-x64-msvc": "0.1.97",
    "@napi-rs/system-ocr-darwin-arm64": "1.2.0",
    "@napi-rs/system-ocr-darwin-x64": "1.2.0",
    "@napi-rs/system-ocr-win32-arm64-msvc": "1.2.0",
    "@napi-rs/system-ocr-win32-x64-msvc": "1.2.0",
    "@node-rs/xxhash-darwin-arm64": "1.7.6",
    "@node-rs/xxhash-darwin-x64": "1.7.6",
    "@node-rs/xxhash-linux-arm64-gnu": "1.7.6",
    "@node-rs/xxhash-linux-arm64-musl": "1.7.6",
    "@node-rs/xxhash-linux-x64-gnu": "1.7.6",
    "@node-rs/xxhash-linux-x64-musl": "1.7.6",
    "@node-rs/xxhash-win32-arm64-msvc": "1.7.6",
    "@node-rs/xxhash-win32-x64-msvc": "1.7.6",
    "node-mac-permissions": "^2.5.0",
    "node-screenshots-darwin-arm64": "0.2.8",
    "node-screenshots-darwin-x64": "0.2.8",
    "node-screenshots-linux-arm64-gnu": "0.2.8",
    "node-screenshots-linux-x64-gnu": "0.2.8",
    "node-screenshots-linux-x64-musl": "0.2.8",
    "node-screenshots-win32-arm64-msvc": "0.2.8",
    "node-screenshots-win32-ia32-msvc": "0.2.8",
    "node-screenshots-win32-x64-msvc": "0.2.8"
  },
  engines: {
    node: ">=24.12.0"
  },
  packageManager: "pnpm@12.6.0+sha512.3ef68f951cb111ac204b4a5a16f0b2ddf0da56a96e0413e81d855d9f0b55ef926714709028e1cd00c405c2c5fb7b9e8ec4dc46777c805d0373c2f2ff00fd20ec",
  desktopName: "MEACowork.desktop"
};

// packages/ui/scripts/build-theme-css.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// packages/ui/scripts/theme-contract.ts
var SHADCN_COLOR_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring"
];
var SHADCN_VARIABLE_TOKENS = [...SHADCN_COLOR_TOKENS, "radius"];
var CHERRY_PRODUCT_COLOR_TOKENS = [
  "background-subtle",
  "foreground-tertiary",
  "foreground-disabled",
  "border-subtle",
  "border-strong",
  "border-selected",
  "link",
  "success",
  "success-subtle",
  "success-subtle-foreground",
  "success-border",
  "warning",
  "warning-subtle",
  "warning-subtle-foreground",
  "warning-border",
  "info",
  "info-subtle",
  "info-subtle-foreground",
  "info-border",
  "error",
  "error-subtle",
  "error-subtle-foreground",
  "error-border",
  "resource-list-row-hover",
  "resource-list-row-active",
  "resource-list-row-active-foreground",
  "resource-list-row-selected",
  "resource-list-row-selected-foreground"
];
var COMPATIBILITY_SEMANTIC_COLOR_TOKENS = [
  "destructive-hover",
  "secondary-hover",
  "secondary-active",
  "ghost-active"
];
var COMPATIBILITY_STATUS_COLOR_TOKENS = [];
var COMPATIBILITY_COLOR_TOKENS = [
  ...COMPATIBILITY_SEMANTIC_COLOR_TOKENS,
  ...COMPATIBILITY_STATUS_COLOR_TOKENS
];

// packages/ui/scripts/build-theme-css.ts
var __electron_vite_injected_import_meta_url = "file:///Users/nanaya/Documents/xuelangyun/cherry-studio/packages/ui/scripts/build-theme-css.ts";
var __filename = fileURLToPath(__electron_vite_injected_import_meta_url);
var __dirname2 = path.dirname(__filename);
var STYLES_DIR = path.resolve(__dirname2, "../src/styles");
var THEME_OUTPUT_PATH = path.join(STYLES_DIR, "theme.css");
var IMPORT_RE = /@import\s+['"]([^'"]+)['"];?/g;
var DARK_BLOCK_RE = /^\.dark \{\n([\s\S]*?)^\}\n/gm;
var RADIUS_LINES = [
  "--radius-4xs: var(--cs-radius-4xs);",
  "--radius-3xs: var(--cs-radius-3xs);",
  "--radius-2xs: var(--cs-radius-2xs);",
  "--radius-xs: var(--cs-radius-xs);",
  "--radius-sm: calc(var(--radius) * 0.6);",
  "--radius-md: calc(var(--radius) * 0.8);",
  "--radius-lg: var(--radius);",
  "--radius-xl: calc(var(--radius) * 1.4);",
  "--radius-2xl: calc(var(--radius) * 1.8);",
  "--radius-3xl: calc(var(--radius) * 2.2);",
  "--radius-4xl: calc(var(--radius) * 2.6);",
  "--radius-full: var(--cs-radius-round);",
  "--radius-round: var(--cs-radius-round);"
];
var SPACING_COMMENT_LINES = [
  "/* Keep spacing opt-in for now to avoid overriding Tailwind container names. */",
  "/* --spacing-5xs: var(--cs-size-5xs);",
  "--spacing-4xs: var(--cs-size-4xs);",
  "--spacing-3xs: var(--cs-size-3xs);",
  "--spacing-2xs: var(--cs-size-2xs);",
  "--spacing-xs: var(--cs-size-xs);",
  "--spacing-sm: var(--cs-size-sm);",
  "--spacing-md: var(--cs-size-md);",
  "--spacing-lg: var(--cs-size-lg);",
  "--spacing-xl: var(--cs-size-xl);",
  "--spacing-2xl: var(--cs-size-2xl);",
  "--spacing-3xl: var(--cs-size-3xl);",
  "--spacing-4xl: var(--cs-size-4xl);",
  "--spacing-5xl: var(--cs-size-5xl);",
  "--spacing-6xl: var(--cs-size-6xl);",
  "--spacing-7xl: var(--cs-size-7xl);",
  "--spacing-8xl: var(--cs-size-8xl); */"
];
var ANIMATION_LINES = [
  "--animate-checkbox-bounce: checkbox-bounce 300ms cubic-bezier(0.4, 0, 0.2, 1);",
  "--animate-checkbox-icon-in: checkbox-icon-in 160ms ease-out both;",
  "",
  "@keyframes checkbox-bounce {",
  "  0%,",
  "  100% {",
  "    transform: scale(1);",
  "  }",
  "",
  "  50% {",
  "    transform: scale(1.08);",
  "  }",
  "}",
  "",
  "@keyframes checkbox-icon-in {",
  "  from {",
  "    opacity: 0;",
  "    transform: scale(0.75);",
  "  }",
  "",
  "  to {",
  "    opacity: 1;",
  "    transform: scale(1);",
  "  }",
  "}"
];
function dedupe(values) {
  return [...new Set(values)];
}
function extractTokenNames(source) {
  return dedupe([...source.matchAll(/^\s*--cs-([a-z0-9-]+)\s*:/gm)].map((match) => match[1]));
}
function toPrefixedMappings(tokenNames, targetPrefix, sourcePrefix = "--cs-") {
  return tokenNames.map((tokenName) => `--${targetPrefix}${tokenName}: var(${sourcePrefix}${tokenName});`);
}
function toColorMappings(tokenNames, sourcePrefix = "--") {
  return tokenNames.map((tokenName) => `--color-${tokenName}: var(${sourcePrefix}${tokenName});`);
}
function toDirectMappings(tokenNames, sourcePrefix = "--cs-") {
  return tokenNames.map((tokenName) => `--${tokenName}: var(${sourcePrefix}${tokenName});`);
}
function buildSection(title, lines) {
  if (lines.length === 0) return "";
  const indentedLines = lines.map((line) => line ? `  ${line}` : "").join("\n");
  return `  /* ==================== */
  /* ${title} */
  /* ==================== */
${indentedLines}`;
}
function buildThemeContractCss(inputs) {
  const sections = [
    buildSection("Compatibility: Primitive Colors", toPrefixedMappings(inputs.primitiveColors, "color-")),
    buildSection("Canonical Shadcn Colors", toColorMappings(SHADCN_COLOR_TOKENS)),
    buildSection("Cherry Studio Product Colors", toColorMappings(CHERRY_PRODUCT_COLOR_TOKENS)),
    buildSection(
      "Compatibility: Existing Semantic Colors",
      toPrefixedMappings(COMPATIBILITY_SEMANTIC_COLOR_TOKENS, "color-")
    ),
    buildSection(
      "Compatibility: Existing Status Colors",
      toPrefixedMappings(COMPATIBILITY_STATUS_COLOR_TOKENS, "color-")
    ),
    buildSection("Spacing", SPACING_COMMENT_LINES),
    buildSection("Radius", RADIUS_LINES),
    buildSection("Typography", toDirectMappings(inputs.typographyTokens)),
    buildSection("Animation", ANIMATION_LINES)
  ];
  return `/**
 * Generated from design tokens.
 *
 * \u26A0\uFE0F DO NOT EDIT DIRECTLY!
 * This file is generated by \`pnpm theme:build\`.
 * Update \`src/styles/tokens/*\`, \`src/styles/theme-input.css\`,
 * \`src/styles/shadcn.css\`, \`src/styles/product.css\`, or the generator
 * contract to change the source.
 */

@import './contract.css';

@theme inline {
${sections.filter(Boolean).join("\n\n")}
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }

  body {
    @apply bg-background text-foreground;
  }
}
`;
}
async function loadThemeContractInputs(stylesDir = STYLES_DIR) {
  const tokensDir = path.join(stylesDir, "tokens");
  const [primitiveColorsSource, typographySource] = await Promise.all([
    fs.readFile(path.join(tokensDir, "colors/primitive.css"), "utf8"),
    fs.readFile(path.join(tokensDir, "typography.css"), "utf8")
  ]);
  return {
    primitiveColors: extractTokenNames(primitiveColorsSource),
    typographyTokens: extractTokenNames(typographySource)
  };
}
async function writeThemeContractCss(outputPath = THEME_OUTPUT_PATH, stylesDir = STYLES_DIR) {
  const inputs = await loadThemeContractInputs(stylesDir);
  const css = buildThemeContractCss(inputs);
  await fs.writeFile(outputPath, css, "utf8");
}
async function buildFlatContractCss(stylesDir = STYLES_DIR) {
  const inline = async (file, seen) => {
    const abs = path.resolve(stylesDir, file);
    if (seen.has(abs)) return "";
    seen.add(abs);
    const raw = await fs.readFile(abs, "utf8");
    const parts = [];
    let last = 0;
    for (const m of raw.matchAll(IMPORT_RE)) {
      parts.push(raw.slice(last, m.index));
      parts.push(await inline(path.join(path.dirname(file), m[1]), seen));
      last = (m.index ?? 0) + m[0].length;
    }
    parts.push(raw.slice(last));
    return parts.join("");
  };
  return mirrorDarkBlocks(await inline("contract.css", /* @__PURE__ */ new Set()));
}
function mirrorDarkBlocks(css) {
  return css.replace(DARK_BLOCK_RE, (block, body) => {
    const indented = body.replace(/^(?=.)/gm, "  ");
    return `${block}
@media (prefers-color-scheme: dark) {
  :root {
${indented}  }
}
`;
  });
}
async function main() {
  await writeThemeContractCss();
}
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  void main();
}

// scripts/checkChunkExports.ts
function chunkExportGuardPlugin() {
  const REQUIRE_RE = /^const ([A-Za-z0-9_$]+) = require\("\.\/([^"]+)"\);$/gm;
  const MEMBER_RE = /([A-Za-z0-9_$]+)\.([A-Za-z0-9_$]+)/g;
  const EXPORT_RE = /(?:exports\.([A-Za-z0-9_$]+)\s*=|Object\.defineProperty\(exports,\s*"([^"]+)")/g;
  return {
    name: "cherry-chunk-export-guard",
    generateBundle(_options, bundle) {
      const exportsOf = /* @__PURE__ */ new Map();
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "chunk") continue;
        const names = /* @__PURE__ */ new Set();
        for (const [, assigned, defined] of output.code.matchAll(EXPORT_RE)) names.add(assigned ?? defined);
        exportsOf.set(fileName, names);
      }
      const broken = /* @__PURE__ */ new Set();
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "chunk") continue;
        const deps = /* @__PURE__ */ new Map();
        for (const [, local, dep] of output.code.matchAll(REQUIRE_RE)) deps.set(local, dep);
        for (const [, local, member] of output.code.matchAll(MEMBER_RE)) {
          const dep = deps.get(local);
          if (dep && !exportsOf.get(dep)?.has(member)) {
            broken.add(`${fileName} reads "${member}" from ${dep}, which does not export it`);
          }
        }
      }
      if (broken.size > 0) {
        this.error(`Broken cross-chunk imports:
  ${[...broken].join("\n  ")}`);
      }
    }
  };
}

// scripts/uiContract/vitePlugin.ts
import { resolve as resolve2 } from "node:path";
import { normalizePath } from "vite";

// scripts/uiContract/scan.ts
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// scripts/uiContract/semanticId.ts
import { relative, sep } from "node:path";
var DOMAIN_ALIASES = /* @__PURE__ */ new Map([
  ["composer", "chat"],
  ["home", "app"],
  ["layout", "app"],
  ["main", "app"]
]);
var COMPONENT_SUFFIXES = /* @__PURE__ */ new Set([
  "component",
  "components",
  "container",
  "impl",
  "provider",
  "renderer",
  "root",
  "wrapper"
]);
var COMPONENT_TECHNICAL_WORDS = /* @__PURE__ */ new Set(["impl", "renderer", "runtime"]);
var ACTION_WORDS = /* @__PURE__ */ new Set([
  "accept",
  "add",
  "back",
  "cancel",
  "clear",
  "close",
  "confirm",
  "copy",
  "create",
  "delete",
  "download",
  "edit",
  "export",
  "import",
  "next",
  "open",
  "pause",
  "play",
  "remove",
  "retry",
  "save",
  "search",
  "select",
  "send",
  "share",
  "stop",
  "submit",
  "toggle",
  "upload"
]);
var EVENT_PLUMBING_WORDS = /* @__PURE__ */ new Set(["default", "event", "propagation"]);
var LOW_INFORMATION_HINTS = /* @__PURE__ */ new Set(["component", "element", "root"]);
var SOURCE_MARKERS = /* @__PURE__ */ new Set(["components", "pages", "windows"]);
function normalizeSourceFile(root, file) {
  return relative(root, file).split(sep).join("/");
}
function identifierWords(value) {
  return value.replace(/([a-z\d])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").toLowerCase().split(/[^a-z\d]+/).filter(Boolean);
}
function unique(words) {
  return words.filter((word, index) => word && words.indexOf(word) === index);
}
function normalizedHint(value) {
  if (!value) return "";
  return identifierWords(value).filter((word) => !LOW_INFORMATION_HINTS.has(word)).slice(0, 4).join("-");
}
function sourceDomain(sourceFile) {
  const path2 = sourceFile.split("/");
  if (sourceFile.startsWith("packages/ui/")) return "ui";
  const markerIndex = path2.findIndex((segment) => SOURCE_MARKERS.has(segment));
  const candidate = markerIndex === -1 ? void 0 : path2[markerIndex + 1];
  if (!candidate || /\.[jt]sx?$|\.html$/.test(candidate) || !/^[a-z]/.test(candidate)) return "ui";
  const normalized = identifierWords(candidate).join("-");
  return DOMAIN_ALIASES.get(normalized) ?? normalized;
}
function componentOwner(component, sourceFile) {
  let words = identifierWords(component).filter((word) => !COMPONENT_TECHNICAL_WORDS.has(word));
  if (words[0] === "use") words.shift();
  while (COMPONENT_SUFFIXES.has(words.at(-1) ?? "")) words.pop();
  if (words.length === 0) {
    const filename = sourceFile.split("/").at(-1)?.replace(/\.(?:html|jsx|tsx)$/, "");
    words = identifierWords(filename ?? "");
  }
  return unique(words).slice(0, 4).join("-") || "surface";
}
function semanticBase(domain, owner) {
  const domainWords = identifierWords(domain);
  const ownerWords = identifierWords(owner);
  while (domainWords.length > 0 && ownerWords[0] === domainWords[0]) {
    domainWords.shift();
    ownerWords.shift();
  }
  return ownerWords.length > 0 ? `${domain}.${ownerWords.join("-")}` : domain;
}
function appendQualifier(base, qualifier) {
  if (!qualifier) return base;
  const owner = base.split(".").at(-1) ?? "";
  const ownerWords = new Set(identifierWords(owner));
  const qualifierWords = identifierWords(qualifier);
  if (qualifierWords.every((word) => ownerWords.has(word))) return base;
  return `${base}.${qualifierWords.join("-")}`;
}
function inferHandlerAction(handler) {
  const words = identifierWords(handler ?? "").filter((word) => !["handle", "handler", "on"].includes(word));
  if (words.some((word) => EVENT_PLUMBING_WORDS.has(word))) return void 0;
  return words.find((word) => ACTION_WORDS.has(word));
}
function inferSemanticId(input) {
  const domain = sourceDomain(input.sourceFile);
  const owner = componentOwner(input.component, input.sourceFile);
  const base = semanticBase(domain, owner);
  const action = inferHandlerAction(input.handler);
  if (action && !input.isComponentRoot) return `${base}.action.${action}`;
  const stableAttribute = [input.testId, input.htmlId, input.name].map((value) => normalizedHint(value)).find(Boolean);
  const authoredRole = normalizedHint(input.part) || normalizedHint(input.role) || stableAttribute || (!input.isComponentRoot ? normalizedHint(input.type) : "");
  return appendQualifier(base, authoredRole);
}

// scripts/uiContract/transform.ts
import { Parser } from "htmlparser2";
import MagicString from "magic-string";
import {
  parseSync
} from "oxc-parser";
var SKIPPED_COMPONENTS = /* @__PURE__ */ new Set(["Consumer", "Fragment", "Provider", "StrictMode", "Suspense"]);
var SKIPPED_HTML_TAGS = /* @__PURE__ */ new Set(["base", "head", "html", "link", "meta", "script", "style", "title"]);
var NON_DOM_COMPONENTS = /* @__PURE__ */ new Set([
  "ContextMenuPrimitive.Portal",
  "ContextMenuPrimitive.Root",
  "ContextMenuPrimitive.Sub",
  "DialogPortal",
  "DialogPrimitive.Portal",
  "DialogPrimitive.Root",
  "DrawerPortal",
  "DrawerPrimitive.Portal",
  "DrawerPrimitive.Root",
  "DropdownMenuPrimitive.Portal",
  "DropdownMenuPrimitive.Root",
  "DropdownMenuPrimitive.Sub",
  "HoverCardPrimitive.Root",
  "PopoverPrimitive.Root",
  "RadixProvider",
  "RadixRoot",
  "SelectPrimitive.Root"
]);
var BOUNDARY_ATTRIBUTES = ["data-testid", "id", "name", "role"];
var SVG_OPT_IN_ATTRIBUTES = ["data-testid", "role"];
var DATA_SLOT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:~-]*$/;
var SEMANTIC_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
var UI_CONTRACT_RUNTIME_MODULE_ID = "virtual:cherry-ui-contract-runtime";
var RUNTIME_MERGE_DATA_UI = "__cherryUiContractMergeDataUi";
var RUNTIME_MERGE_UI_PROPS = "__cherryUiContractMergeUiProps";
var RUNTIME_SLOT = "__CherryUiContractSlot";
function hasSvgContractOptIn(info) {
  return info.attributes.has("data-ui") || info.parts.length > 0 || SVG_OPT_IN_ATTRIBUTES.some((name) => hasStaticAttribute(info.attributes, name)) || inferHandlerAction(info.handler) !== void 0;
}
function hasSemanticSignal(info) {
  return info.attributes.has("data-ui") || info.parts.length > 0 || BOUNDARY_ATTRIBUTES.some((name) => hasStaticAttribute(info.attributes, name)) || inferHandlerAction(info.handler) !== void 0;
}
function hasStaticAttribute(attributes, name) {
  const attribute = attributes.get(name);
  return Boolean(attribute && !attribute.dynamic && attribute.value);
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function jsxName(name) {
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXNamespacedName") return `${name.namespace.name}:${name.name.name}`;
  return `${jsxName(name.object)}.${name.property.name}`;
}
function directHandlerIdentifier(value) {
  if (!isRecord(value)) return void 0;
  if (value.type === "Identifier" && typeof value.name === "string") return value.name;
  if ((value.type === "MemberExpression" || value.type === "OptionalMemberExpression") && isRecord(value.property)) {
    return directHandlerIdentifier(value.property);
  }
  if (value.type === "ChainExpression" && isRecord(value.expression)) {
    return directHandlerIdentifier(value.expression);
  }
  return void 0;
}
function staticJsxAttribute(attribute) {
  if (!attribute.value) return { attribute, dynamic: false, value: "" };
  if (attribute.value.type === "Literal" && typeof attribute.value.value === "string") {
    return { attribute, dynamic: false, value: attribute.value.value };
  }
  if (attribute.value.type === "JSXExpressionContainer") {
    const expression = attribute.value.expression;
    if (expression.type === "Literal" && typeof expression.value === "string") {
      return { attribute, dynamic: false, value: expression.value };
    }
  }
  return { attribute, dynamic: true };
}
function namespaceTokenValues(value, namespace) {
  const prefix = `${namespace}:`;
  return (value ?? "").split(/\s+/).filter((token) => token.startsWith(prefix) && token.length > prefix.length).map((token) => token.slice(prefix.length));
}
function assertAuthoredDataUi(value) {
  for (const token of (value ?? "").split(/\s+/).filter(Boolean)) {
    const separator = token.indexOf(":");
    if (separator === -1) {
      if (!SEMANTIC_ID.test(token)) throw new Error(`Invalid data-ui semantic token: ${token}`);
      continue;
    }
    if (token.slice(0, separator) !== "part") throw new Error(`Unknown data-ui token namespace: ${token}`);
    if (!DATA_SLOT_VALUE.test(token.slice(separator + 1))) throw new Error(`Invalid data-ui part token: ${token}`);
  }
}
function staticDataSlot(attributes) {
  const dataSlot = attributes.get("data-slot");
  if (!dataSlot) return void 0;
  if (dataSlot.dynamic || !dataSlot.value || !DATA_SLOT_VALUE.test(dataSlot.value)) {
    throw new Error("data-slot must be a static token");
  }
  return dataSlot.value;
}
function openingElementInfo(opening) {
  const attributes = /* @__PURE__ */ new Map();
  const spreads = [];
  let handler;
  for (const attribute of opening.attributes) {
    if (attribute.type === "JSXSpreadAttribute") {
      spreads.push(attribute);
      continue;
    }
    if (attribute.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier") continue;
    const name = attribute.name.name;
    const info = staticJsxAttribute(attribute);
    attributes.set(name, info);
    if (/^on[A-Z]/.test(name) && attribute.value?.type === "JSXExpressionContainer") {
      const candidate = directHandlerIdentifier(attribute.value.expression);
      if (candidate && (handler === void 0 || inferHandlerAction(candidate))) {
        handler = candidate;
      }
    }
  }
  const element = jsxName(opening.name);
  const dataSlotPart = staticDataSlot(attributes);
  const parts = [.../* @__PURE__ */ new Set([...namespaceTokenValues(attributes.get("data-ui")?.value, "part"), dataSlotPart])].filter(
    (part) => Boolean(part)
  );
  const staticDataUi = attributes.get("data-ui")?.dynamic ? void 0 : attributes.get("data-ui")?.value;
  assertAuthoredDataUi(staticDataUi);
  const authoredDataUi = mergePartsDataUi(staticDataUi, parts);
  return {
    attributes,
    authoredDataUi,
    element,
    handler,
    parts,
    requiresDataUiInjection: authoredDataUi !== staticDataUi,
    spreads
  };
}
function explicitSemanticId(dataUi) {
  if (!dataUi?.value || dataUi.dynamic) return void 0;
  return dataUi.value.split(/\s+/).find((token) => token && !token.includes(":"));
}
function componentNameFromNode(node) {
  if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && isRecord(node.id)) {
    return typeof node.id.name === "string" ? node.id.name : void 0;
  }
  if (node.type === "VariableDeclarator" && isRecord(node.id) && node.id.type === "Identifier" && isRecord(node.init)) {
    if (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression") {
      return typeof node.id.name === "string" ? node.id.name : void 0;
    }
  }
  return void 0;
}
function defaultComponentName(sourceFile) {
  const filename = sourceFile.split("/").at(-1)?.replace(/\.(?:jsx|tsx)$/, "") ?? "Anonymous";
  return filename === "index" ? sourceFile.split("/").at(-2) ?? "Anonymous" : filename;
}
function mergeDataUi(existing, semanticId) {
  const existingTokens = (existing ?? "").split(/\s+/).filter(Boolean);
  const semanticTokens = existingTokens.filter((token) => !token.includes(":"));
  const partTokens = existingTokens.filter((token) => token.startsWith("part:"));
  return [.../* @__PURE__ */ new Set([semanticId, ...semanticTokens, ...partTokens])].join(" ");
}
function mergePartsDataUi(existing, parts) {
  if (!existing && parts.length === 0) return void 0;
  const existingTokens = (existing ?? "").split(/\s+/).filter(Boolean);
  const semanticTokens = existingTokens.filter((token) => !token.includes(":"));
  const partTokens = [
    ...existingTokens.filter((token) => token.startsWith("part:")),
    ...parts.map((part) => `part:${part}`)
  ];
  return [.../* @__PURE__ */ new Set([...semanticTokens, ...partTokens])].join(" ");
}
function transformJsx(source, options) {
  const parsed = parseSync(options.sourceFile, source, { lang: "tsx", sourceType: "unambiguous" });
  if (parsed.errors.length > 0) {
    const details = parsed.errors.map((error) => error.codeframe?.trim() || error.message).join("\n");
    throw new Error(`Failed to parse ${options.sourceFile} with Oxc:
${details}`);
  }
  const program = parsed.program;
  const magicString = new MagicString(source);
  const spanToCharacter = (offset) => offset;
  const descriptors = [];
  const runtimeImports = /* @__PURE__ */ new Set();
  function expressionSource(span) {
    return source.slice(spanToCharacter(span.start), spanToCharacter(span.end));
  }
  function requiredSpan(value, description) {
    if (!isRecord(value) || typeof value.start !== "number" || typeof value.end !== "number") {
      throw new Error(`Missing ${description} span`);
    }
    return { start: value.start, end: value.end };
  }
  function injectDataUi(opening, existing, contract) {
    const dynamicExpressions = [];
    const attribute = existing?.attribute;
    if (existing?.dynamic && attribute?.value?.type === "JSXExpressionContainer" && attribute.value.expression.type !== "JSXEmptyExpression") {
      dynamicExpressions.push(expressionSource(requiredSpan(attribute.value.expression, "data-ui expression")));
    }
    if (attribute) {
      magicString.remove(spanToCharacter(attribute.start), spanToCharacter(attribute.end));
    }
    const nameSpan = requiredSpan(opening.name, `JSX element-name for ${jsxName(opening.name)}`);
    const dataUiValue = dynamicExpressions.length > 0 ? `{${RUNTIME_MERGE_DATA_UI}(${JSON.stringify(contract)}, ${dynamicExpressions.join(", ")})}` : JSON.stringify(contract);
    magicString.appendLeft(spanToCharacter(nameSpan.end), ` data-ui=${dataUiValue}`);
    if (dynamicExpressions.length > 0) runtimeImports.add("mergeDataUi");
    for (const spread of opening.attributes) {
      if (spread.type !== "JSXSpreadAttribute") continue;
      const spreadSpan = requiredSpan(spread.argument, "JSX spread expression");
      const spreadSource = expressionSource(spreadSpan);
      magicString.overwrite(
        spanToCharacter(spreadSpan.start),
        spanToCharacter(spreadSpan.end),
        `${RUNTIME_MERGE_UI_PROPS}(${spreadSource}, ${JSON.stringify(contract)})`
      );
      runtimeImports.add("mergeUiProps");
    }
  }
  function processOpening(opening, component, insideSvg, hasBoundaryAncestor, nearestSemanticId) {
    const info = openingElementInfo(opening);
    const elementLeaf = info.element.split(".").at(-1) ?? info.element;
    if (SKIPPED_COMPONENTS.has(elementLeaf) || NON_DOM_COMPONENTS.has(info.element)) return;
    if (SKIPPED_HTML_TAGS.has(info.element)) return;
    const existingDataUi = info.attributes.get("data-ui");
    const explicitSemantic = explicitSemanticId(existingDataUi);
    const isIntrinsicElement = /^[a-z]/.test(info.element);
    if (!isIntrinsicElement) {
      if (options.injectDataUi && info.authoredDataUi && (info.requiresDataUiInjection || existingDataUi?.value && !existingDataUi.dynamic && info.spreads.length > 0)) {
        injectDataUi(opening, existingDataUi, info.authoredDataUi);
      }
      if (!explicitSemantic && info.parts.length === 0) return;
      descriptors.push({
        component,
        element: info.element,
        kind: "jsx",
        parts: info.parts,
        // A part-only call site joins the contract through its parts; the
        // semantic id lives on the component implementation's own root.
        semanticId: explicitSemantic ?? "",
        semanticSource: "explicit",
        sourceFile: options.sourceFile,
        sourceOffset: spanToCharacter(opening.start)
      });
      return explicitSemantic;
    }
    if (insideSvg && info.element !== "svg" && !hasSvgContractOptIn(info)) return;
    if (hasBoundaryAncestor && !hasSemanticSignal(info)) return;
    const semanticId = explicitSemantic ?? inferSemanticId({
      component,
      element: info.element,
      handler: info.handler,
      htmlId: info.attributes.get("id")?.value,
      isComponentRoot: !hasBoundaryAncestor,
      name: info.attributes.get("name")?.value,
      part: info.parts[0],
      role: info.attributes.get("role")?.value,
      sourceFile: options.sourceFile,
      testId: info.attributes.get("data-testid")?.value,
      type: info.attributes.get("type")?.value
    });
    if (!explicitSemantic && !info.authoredDataUi && semanticId === nearestSemanticId) return void 0;
    const descriptor = {
      component,
      element: info.element,
      kind: "jsx",
      parts: info.parts,
      semanticId,
      semanticSource: explicitSemantic ? "explicit" : "inferred",
      sourceFile: options.sourceFile,
      sourceOffset: spanToCharacter(opening.start)
    };
    descriptors.push(descriptor);
    if (options.injectDataUi) {
      injectDataUi(opening, existingDataUi, mergeDataUi(info.authoredDataUi, descriptor.semanticId));
    }
    return semanticId;
  }
  function shouldWrapAsChildContent(opening) {
    const attribute = opening.attributes.find(
      (attribute2) => attribute2.type === "JSXAttribute" && attribute2.name.type === "JSXIdentifier" && attribute2.name.name === "asChild"
    );
    if (!attribute || attribute.type !== "JSXAttribute") return false;
    if (!attribute.value) return true;
    return !(attribute.value.type === "JSXExpressionContainer" && attribute.value.expression.type === "Literal" && !attribute.value.expression.value);
  }
  function walk(value, component, insideSvg = false, hasBoundaryAncestor = false, nearestSemanticId) {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, component, insideSvg, hasBoundaryAncestor, nearestSemanticId);
      return;
    }
    if (!isRecord(value)) return;
    const nestedComponent = componentNameFromNode(value) ?? component;
    if (value.type === "JSXElement" && isRecord(value.openingElement) && value.openingElement.type === "JSXOpeningElement") {
      const opening = value.openingElement;
      const element = jsxName(opening.name);
      const isIntrinsicElement = /^[a-z]/.test(element);
      const semanticId = processOpening(opening, nestedComponent, insideSvg, hasBoundaryAncestor, nearestSemanticId);
      const childrenInsideSvg = element === "foreignObject" ? false : insideSvg || element === "svg";
      const elementLeaf = element.split(".").at(-1) ?? element;
      const isComponentBoundary = !isIntrinsicElement && !SKIPPED_COMPONENTS.has(elementLeaf) && !NON_DOM_COMPONENTS.has(element);
      const childrenHaveBoundaryAncestor = element === "foreignObject" ? false : hasBoundaryAncestor || isIntrinsicElement || isComponentBoundary;
      const childSemanticId = element === "foreignObject" ? void 0 : semanticId ?? nearestSemanticId;
      if (options.injectDataUi && !/^[a-z]/.test(element) && shouldWrapAsChildContent(opening) && Array.isArray(value.children) && value.children.length > 0 && isRecord(value.closingElement)) {
        const closingSpan = requiredSpan(value.closingElement, "JSX closing element");
        magicString.appendLeft(spanToCharacter(opening.end), `<${RUNTIME_SLOT}>`);
        magicString.appendLeft(spanToCharacter(closingSpan.start), `</${RUNTIME_SLOT}>`);
        runtimeImports.add("UiDataSlot");
      }
      if (Array.isArray(value.children)) {
        walk(value.children, nestedComponent, childrenInsideSvg, childrenHaveBoundaryAncestor, childSemanticId);
      }
      for (const attribute of opening.attributes) {
        if (attribute.type === "JSXAttribute" && attribute.value?.type === "JSXExpressionContainer") {
          walk(
            attribute.value.expression,
            nestedComponent,
            childrenInsideSvg,
            childrenHaveBoundaryAncestor,
            childSemanticId
          );
        }
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "start" || key === "end" || key === "parent" || key === "type") continue;
      walk(child, nestedComponent, insideSvg, hasBoundaryAncestor, nearestSemanticId);
    }
  }
  walk(program, defaultComponentName(options.sourceFile));
  if (options.injectDataUi && runtimeImports.size > 0) {
    const imports = [...runtimeImports].sort().map((name) => {
      if (name === "mergeDataUi") return `mergeDataUi as ${RUNTIME_MERGE_DATA_UI}`;
      if (name === "mergeUiProps") return `mergeUiProps as ${RUNTIME_MERGE_UI_PROPS}`;
      return `UiDataSlot as ${RUNTIME_SLOT}`;
    }).join(", ");
    const statement = `import { ${imports} } from ${JSON.stringify(UI_CONTRACT_RUNTIME_MODULE_ID)}
`;
    let insertAt = 0;
    for (const item of program.body) {
      if (item.type !== "ExpressionStatement" || !isRecord(item.expression) || item.expression.type !== "Literal" || typeof item.expression.value !== "string") {
        break;
      }
      insertAt = spanToCharacter(item.end);
    }
    if (insertAt === 0) magicString.prepend(statement);
    else magicString.appendLeft(insertAt, `
${statement}`);
  }
  return {
    code: options.injectDataUi ? magicString.toString() : source,
    descriptors,
    map: options.injectDataUi ? magicString.generateMap({
      file: options.sourceFile,
      hires: true,
      includeContent: true,
      source: options.sourceFile
    }) : null
  };
}
function htmlTags(source) {
  const tags = [];
  const svgContext = [];
  const parentStack = [];
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const insideSvg = svgContext.at(-1) ?? false;
        svgContext.push(name === "foreignobject" ? false : insideSvg || name === "svg");
        const start = parser.startIndex;
        const end = parser.endIndex + 1;
        const index = tags.length;
        tags.push({
          attributes,
          end,
          index,
          insideSvg,
          name,
          parentIndex: parentStack.at(-1),
          source: source.slice(start, end),
          start
        });
        parentStack.push(index);
      },
      onclosetag() {
        svgContext.pop();
        parentStack.pop();
      }
    },
    { decodeEntities: false, recognizeSelfClosing: true }
  );
  parser.end(source);
  return tags;
}
function htmlAttribute(tag, name) {
  return tag.attributes[name.toLowerCase()];
}
function staticHtmlDataSlot(tag) {
  const dataSlot = htmlAttribute(tag, "data-slot");
  if (dataSlot === void 0) return void 0;
  if (!dataSlot || !DATA_SLOT_VALUE.test(dataSlot)) throw new Error("data-slot must be a static token");
  return dataSlot;
}
function hasHtmlSvgContractOptIn(tag) {
  return htmlAttribute(tag, "data-ui") !== void 0 || htmlAttribute(tag, "data-slot") !== void 0 || SVG_OPT_IN_ATTRIBUTES.some((name) => htmlAttribute(tag, name) !== void 0);
}
function hasHtmlSemanticSignal(tag) {
  return htmlAttribute(tag, "data-ui") !== void 0 || htmlAttribute(tag, "data-slot") !== void 0 || BOUNDARY_ATTRIBUTES.some((name) => htmlAttribute(tag, name) !== void 0);
}
function transformHtml(source, options) {
  const magicString = new MagicString(source);
  const descriptors = [];
  const tags = htmlTags(source);
  for (const tag of tags) {
    if (SKIPPED_HTML_TAGS.has(tag.name)) continue;
    assertAuthoredDataUi(htmlAttribute(tag, "data-ui"));
    const dataSlotPart = staticHtmlDataSlot(tag);
    if (tag.insideSvg && tag.name !== "svg" && !hasHtmlSvgContractOptIn(tag)) continue;
    const parent = tag.parentIndex === void 0 ? void 0 : tags[tag.parentIndex];
    const isBoundaryRoot = parent === void 0 || parent.name === "foreignobject";
    if (!isBoundaryRoot && !hasHtmlSemanticSignal(tag)) continue;
    const existing = htmlAttribute(tag, "data-ui");
    const parts = [.../* @__PURE__ */ new Set([...namespaceTokenValues(existing, "part"), dataSlotPart])].filter(
      (part) => Boolean(part)
    );
    const authoredDataUi = mergePartsDataUi(existing, parts);
    const explicitSemantic = existing?.split(/\s+/).find((token) => token && !token.includes(":"));
    const semanticId = explicitSemantic ?? (tag.name === "body" ? "app.window" : inferSemanticId({
      component: options.windowName,
      element: tag.name,
      htmlId: htmlAttribute(tag, "id"),
      isComponentRoot: isBoundaryRoot,
      name: htmlAttribute(tag, "name"),
      part: parts[0],
      role: htmlAttribute(tag, "role"),
      sourceFile: options.sourceFile,
      testId: htmlAttribute(tag, "data-testid"),
      type: htmlAttribute(tag, "type")
    }));
    const descriptor = {
      component: options.windowName,
      element: tag.name,
      kind: "html",
      parts,
      semanticId,
      semanticSource: explicitSemantic ? "explicit" : "inferred",
      sourceFile: options.sourceFile,
      sourceOffset: tag.start
    };
    descriptors.push(descriptor);
    if (!options.injectDataUi) continue;
    const value = mergeDataUi(authoredDataUi, descriptor.semanticId);
    if (existing !== void 0) {
      const attribute = tag.source.match(/\sdata-ui\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i);
      if (attribute?.index === void 0) {
        throw new Error(`Failed to rewrite data-ui attribute on <${tag.name}> in ${options.sourceFile}`);
      }
      const start = tag.start + attribute.index;
      magicString.overwrite(start, start + attribute[0].length, ` data-ui=${JSON.stringify(value)}`);
    } else {
      let insertAt = tag.source.endsWith("/>") ? tag.end - 2 : tag.end - 1;
      while (/\s/.test(source[insertAt - 1])) insertAt -= 1;
      magicString.appendLeft(insertAt, ` data-ui=${JSON.stringify(value)}`);
    }
  }
  return {
    code: options.injectDataUi ? magicString.toString() : source,
    descriptors,
    map: null
  };
}

// scripts/uiContract/scan.ts
var EXCLUDED_FILE_PATTERNS = [/\.gen\.[jt]sx?$/, /\.(?:spec|test|stories)\.[jt]sx?$/];
function isUiSourceFile(file) {
  const normalized = file.replaceAll("\\", "/");
  if (!/\.(?:html|jsx|tsx)$/.test(normalized)) return false;
  if (normalized.includes("/node_modules/") || normalized.includes("/__tests__/")) return false;
  return !EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}
function windowNameFromHtml(sourceFile) {
  const parts = sourceFile.replace(/\/index\.html$/, "").split("/");
  const windowIndex = parts.lastIndexOf("windows");
  return (windowIndex >= 0 ? parts.slice(windowIndex + 1) : parts.slice(-2)).join(".") || "main";
}

// scripts/uiContract/vitePlugin.ts
var RESOLVED_RUNTIME_MODULE_ID = `\0${UI_CONTRACT_RUNTIME_MODULE_ID}`;
function uiContractPlugin(options = {}) {
  const root = resolve2(options.root ?? process.cwd());
  return {
    name: "cherry-ui-contract",
    enforce: "pre",
    resolveId(id) {
      return id === UI_CONTRACT_RUNTIME_MODULE_ID ? RESOLVED_RUNTIME_MODULE_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_RUNTIME_MODULE_ID) return null;
      const runtimePath = normalizePath(resolve2(root, "scripts/uiContract/runtime.ts"));
      const slotPath = normalizePath(resolve2(root, "scripts/uiContract/uiDataSlot.ts"));
      return `
export { mergeDataUi, mergeUiProps } from ${JSON.stringify(runtimePath)}
export { UiDataSlot } from ${JSON.stringify(slotPath)}
`;
    },
    transform(source, id) {
      const file = id.split("?")[0];
      if (!isUiSourceFile(file) || !/\.(?:jsx|tsx)$/.test(file)) return null;
      const sourceFile = normalizeSourceFile(root, file);
      if (sourceFile.startsWith("../")) return null;
      const result = transformJsx(source, {
        injectDataUi: true,
        sourceFile
      });
      return { code: result.code, map: result.map };
    },
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        if (!context.filename) return html;
        const sourceFile = normalizeSourceFile(root, context.filename);
        const result = transformHtml(html, {
          injectDataUi: true,
          sourceFile,
          windowName: windowNameFromHtml(sourceFile)
        });
        return result.code;
      }
    }
  };
}

// src/shared/types/appEdition.ts
var APP_EDITIONS = ["global", "cn"];

// src/shared/utils/releaseNotes.ts
import { rcompare as compareSemverDescending } from "semver";
var RELEASE_NOTE_MARKERS = {
  english: "<!--LANG:en-->",
  chinese: "<!--LANG:zh-CN-->",
  end: "<!--LANG:END-->"
};
var STABLE_RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function hasCompleteLanguageMarkers(releaseNotes) {
  const englishMarker = releaseNotes.indexOf(RELEASE_NOTE_MARKERS.english);
  const chineseMarker = releaseNotes.indexOf(RELEASE_NOTE_MARKERS.chinese, englishMarker + 1);
  const endMarker = releaseNotes.indexOf(RELEASE_NOTE_MARKERS.end, chineseMarker + 1);
  return englishMarker >= 0 && chineseMarker > englishMarker && endMarker > chineseMarker;
}
function parseReleaseHistory(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("release-history.json must contain valid JSON");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("release-history.json must contain a non-empty array");
  }
  const versions = /* @__PURE__ */ new Set();
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`release-history.json entry ${index} must be an object`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== "releaseNotes" || keys[1] !== "version") {
      throw new Error(`release-history.json entry ${index} must contain only version and releaseNotes`);
    }
    const { releaseNotes, version } = entry;
    if (typeof version !== "string" || !STABLE_RELEASE_VERSION_PATTERN.test(version)) {
      throw new Error(`release-history.json entry ${index} must have a stable semantic version`);
    }
    if (versions.has(version)) {
      throw new Error(`release-history.json contains duplicate version ${version}`);
    }
    if (typeof releaseNotes !== "string" || !releaseNotes.trim() || !hasCompleteLanguageMarkers(releaseNotes)) {
      throw new Error(`release-history.json entry ${index} must have complete bilingual release notes`);
    }
    versions.add(version);
    return { releaseNotes, version };
  });
}
function validateCurrentReleaseHistory(current, history) {
  if (!STABLE_RELEASE_VERSION_PATTERN.test(current.version)) return;
  if (!history.some(({ version }) => version === current.version)) {
    throw new Error(`release-history.json must contain current stable version ${current.version}`);
  }
}

// src/shared/utils/sentry.ts
import { prerelease } from "semver";
function getSentryBuildContext(name, version, edition) {
  return {
    release: `${name}@${version}`,
    tags: {
      "app.version": version,
      "app.edition": edition,
      "app.channel": String(prerelease(version)?.[0] ?? "stable")
    }
  };
}

// electron.vite.config.ts
var __electron_vite_injected_dirname = "/Users/nanaya/Documents/xuelangyun/cherry-studio";
var electronBuilderConfig = parse(
  readFileSync(resolve3(__electron_vite_injected_dirname, "electron-builder.yml"), "utf8")
);
var bundledReleaseNotes = electronBuilderConfig.releaseInfo?.releaseNotes;
var bundledReleaseHistory = parseReleaseHistory(
  readFileSync(resolve3(__electron_vite_injected_dirname, "resources/cherry-studio/release-history.json"), "utf8")
);
if (typeof bundledReleaseNotes !== "string" || !bundledReleaseNotes.trim()) {
  throw new Error("electron-builder.yml must define non-empty releaseInfo.releaseNotes");
}
validateCurrentReleaseHistory({ releaseNotes: bundledReleaseNotes, version: package_default.version }, bundledReleaseHistory);
var visualizerPlugin = (type) => {
  return process.env[`VISUALIZER_${type.toUpperCase()}`] ? [visualizer({ open: true })] : [];
};
var isDev = process.env.NODE_ENV === "development";
var isProd = process.env.NODE_ENV === "production";
var SENTRY_UPLOAD_ENV_KEYS = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"];
function resolveSentryBuildSettings(env) {
  const sourceMapUploadEnabled2 = env.NODE_ENV === "production" && env.SENTRY_SOURCE_MAP_UPLOAD === "true";
  const missingUploadEnv = sourceMapUploadEnabled2 ? SENTRY_UPLOAD_ENV_KEYS.filter((key) => !env[key]?.trim()) : [];
  if (missingUploadEnv.length > 0) {
    throw new Error(`Sentry production builds require: ${missingUploadEnv.join(", ")}`);
  }
  return { sourceMapUploadEnabled: sourceMapUploadEnabled2 };
}
function resolveRendererEdition(value) {
  const edition = value?.trim().toLowerCase() || "global";
  if (APP_EDITIONS.includes(edition)) return edition;
  throw new Error(`Unsupported renderer edition: ${edition}`);
}
var DEFAULT_XUELANG_API_ORIGIN = "https://api.xuelanglm.com";
function resolveXuelangApiOrigin(value) {
  const raw = value?.trim();
  if (!raw) return DEFAULT_XUELANG_API_ORIGIN;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`XUELANG_API_ORIGIN is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`XUELANG_API_ORIGIN must use http(s), got: ${raw}`);
  }
  return url.origin;
}
var rendererEdition = resolveRendererEdition(process.env.CHERRY_EDITION);
var xuelangApiOrigin = resolveXuelangApiOrigin(process.env.XUELANG_API_ORIGIN);
var sentryBuildContext = getSentryBuildContext(package_default.name, package_default.version, rendererEdition);
var { sourceMapUploadEnabled } = resolveSentryBuildSettings(process.env);
var sentrySourceMap = sourceMapUploadEnabled ? "hidden" : isDev;
var sentrySourceMapPlugins = (outputDirectory) => sourceMapUploadEnabled ? sentryVitePlugin({
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  telemetry: false,
  release: {
    name: sentryBuildContext.release,
    create: false,
    finalize: false,
    setCommits: false
  },
  sourcemaps: {
    filesToDeleteAfterUpload: `./out/${outputDirectory}/**/*.map`
  }
}) : [];
var mainExternalDependencies = [
  ...Object.keys(package_default.dependencies),
  // optionalDependencies too: platform-gated natives (e.g. node-mac-permissions) are real import
  // targets, not napi sub-packages, so rollup would fail on the .node; production keeps them installed.
  ...Object.keys(package_default.optionalDependencies ?? {})
];
var mainExternalModules = ["bufferutil", "utf-8-validate", "electron", ...mainExternalDependencies];
var isMainExternalModule = (id) => {
  return mainExternalModules.some((moduleId) => id === moduleId || id.startsWith(`${moduleId}/`));
};
var miniAppThemeAssetPlugin = () => ({
  name: "cherry-mini-app-theme-asset",
  // The sources live outside the main bundle's module graph, so `electron-vite dev` would
  // serve a stale `miniAppTheme.css` after a token edit. Registered in `buildStart` because
  // `addWatchFile` is a build-phase call — it is not available from `generateBundle`.
  buildStart() {
    const stylesDir = resolve3("packages/ui/src/styles");
    for (const name of readdirSync(stylesDir, { recursive: true, encoding: "utf8" })) {
      if (name.endsWith(".css")) this.addWatchFile(join(stylesDir, name));
    }
  },
  async generateBundle() {
    let source;
    try {
      source = await buildFlatContractCss();
    } catch (error) {
      return this.error(`failed to build assets/miniAppTheme.css: ${error instanceof Error ? error.message : error}`);
    }
    this.emitFile({ type: "asset", fileName: "assets/miniAppTheme.css", source });
  }
});
var mainResolveAlias = {
  "@main": resolve3("src/main"),
  "@application": resolve3("src/main/core/application/Application"),
  "@data": resolve3("src/main/data"),
  "@shared": resolve3("src/shared"),
  "@logger": resolve3("src/main/core/logger/LoggerService"),
  "@cherrystudio/ai-core/provider": resolve3("packages/aiCore/src/core/providers"),
  "@cherrystudio/ai-core/built-in/plugins": resolve3("packages/aiCore/src/core/plugins/built-in"),
  "@cherrystudio/ai-core": resolve3("packages/aiCore/src"),
  "@cherrystudio/ai-sdk-provider": resolve3("packages/ai-sdk-provider/src"),
  "@cherrystudio/provider-registry/node": resolve3("packages/provider-registry/src/registry-loader"),
  "@cherrystudio/provider-registry": resolve3("packages/provider-registry/src"),
  "@test-mocks": resolve3("tests/__mocks__"),
  "@test-helpers": resolve3("tests/helpers")
};
var electron_vite_config_default = defineConfig({
  main: {
    define: {
      __APP_EDITION__: JSON.stringify(rendererEdition),
      __XUELANG_API_ORIGIN__: JSON.stringify(xuelangApiOrigin)
    },
    plugins: [
      chunkExportGuardPlugin(),
      miniAppThemeAssetPlugin(),
      ...visualizerPlugin("main"),
      ...sentrySourceMapPlugins("main")
    ],
    resolve: { alias: mainResolveAlias },
    build: {
      externalizeDeps: {
        include: mainExternalModules
      },
      lib: { entry: resolve3(__electron_vite_injected_dirname, "src/main/main.ts") },
      rolldownOptions: {
        output: {
          manualChunks: (id) => {
            if (id.includes("/node_modules/conf/")) return "electron-store-conf";
            if (id.includes("/node_modules/@ai-sdk/openai/")) return "ai-sdk-openai";
            return void 0;
          },
          comments: isProd ? { legal: false } : void 0
        },
        onwarn(warning, warn) {
          if (warning.code === "COMMONJS_VARIABLE_IN_ESM") return;
          warn(warning);
        }
      },
      sourcemap: sentrySourceMap
    },
    optimizeDeps: {
      noDiscovery: isDev
    }
  },
  preload: {
    plugins: [...sentrySourceMapPlugins("preload")],
    resolve: {
      alias: {
        "@shared": resolve3("src/shared")
      }
    },
    build: {
      sourcemap: sentrySourceMap,
      rolldownOptions: {
        // Unlike renderer which auto-discovers entries from HTML files,
        // preload requires explicit entry point configuration for multiple scripts
        input: {
          preload: resolve3(__electron_vite_injected_dirname, "src/preload/preload.ts"),
          simplest: resolve3(__electron_vite_injected_dirname, "src/preload/simplest.ts"),
          // Minimal preload
          webview: resolve3(__electron_vite_injected_dirname, "src/preload/webview.ts"),
          // Site `<webview>` guests
          miniAppBridge: resolve3(__electron_vite_injected_dirname, "src/preload/miniAppBridge.ts")
          // Local mini app guests (`window.cherry`)
        },
        external: ["electron"],
        output: {
          entryFileNames: "[name].js",
          format: "cjs"
        }
      }
    }
  },
  renderer: {
    define: {
      __APP_EDITION__: JSON.stringify(rendererEdition),
      __XUELANG_API_ORIGIN__: JSON.stringify(xuelangApiOrigin),
      __APP_RELEASE_HISTORY__: JSON.stringify(bundledReleaseHistory),
      __APP_RELEASE_NOTES__: JSON.stringify(bundledReleaseNotes),
      __APP_RELEASE_VERSION__: JSON.stringify(package_default.version)
    },
    plugins: [
      uiContractPlugin(),
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        routesDirectory: resolve3("src/renderer/routes"),
        generatedRouteTree: resolve3("src/renderer/routeTree.gen.ts")
      }),
      tailwindcss(),
      react(),
      ...isDev ? [CodeInspectorPlugin({ bundler: "vite" })] : [],
      // 只在开发环境下启用 CodeInspectorPlugin
      ...visualizerPlugin("renderer"),
      ...sentrySourceMapPlugins("renderer")
    ],
    resolve: {
      alias: {
        "@renderer": resolve3("src/renderer"),
        "@shared": resolve3("src/shared"),
        "@logger": resolve3("src/renderer/services/LoggerService"),
        "@data": resolve3("src/renderer/data"),
        "@cherrystudio/ai-core/provider": resolve3("packages/aiCore/src/core/providers"),
        "@cherrystudio/ai-core/built-in/plugins": resolve3("packages/aiCore/src/core/plugins/built-in"),
        "@cherrystudio/ai-core": resolve3("packages/aiCore/src"),
        "@cherrystudio/extension-table-plus": resolve3("packages/extension-table-plus/src"),
        "@cherrystudio/ai-sdk-provider": resolve3("packages/ai-sdk-provider/src"),
        "@cherrystudio/provider-registry/node": resolve3("packages/provider-registry/src/registry-loader"),
        "@cherrystudio/provider-registry": resolve3("packages/provider-registry/src"),
        "@cherrystudio/ui/icons/providers": resolve3("packages/ui/src/components/icons/providers"),
        "@cherrystudio/ui/icons": resolve3("packages/ui/src/components/icons"),
        "@cherrystudio/ui": resolve3("packages/ui/src"),
        "@test-mocks": resolve3("tests/__mocks__")
      }
    },
    optimizeDeps: {
      exclude: ["pyodide"],
      rolldownOptions: {
        transform: {
          target: "esnext"
          // for dev
        }
      }
    },
    worker: {
      format: "es"
    },
    build: {
      sourcemap: sentrySourceMap,
      target: "esnext",
      // for build
      rolldownOptions: {
        input: {
          index: resolve3(__electron_vite_injected_dirname, "src/renderer/windows/main/index.html"),
          quickAssistant: resolve3(__electron_vite_injected_dirname, "src/renderer/windows/quickAssistant/index.html"),
          selectionToolbar: resolve3(__electron_vite_injected_dirname, "src/renderer/windows/selection/toolbar/index.html"),
          selectionAction: resolve3(__electron_vite_injected_dirname, "src/renderer/windows/selection/action/index.html"),
          migrationV2: resolve3(__electron_vite_injected_dirname, "src/renderer/windows/migrationV2/index.html"),
          userDataRelocation: resolve3(__electron_vite_injected_dirname, "src/renderer/windows/userDataRelocation/index.html"),
          subWindow: resolve3(__electron_vite_injected_dirname, "src/renderer/windows/subWindow/index.html"),
          screenshot: resolve3(__electron_vite_injected_dirname, "src/renderer/windows/screenshot/index.html")
        },
        onwarn(warning, warn) {
          if (warning.code === "COMMONJS_VARIABLE_IN_ESM") return;
          warn(warning);
        },
        output: {
          comments: isProd ? { legal: false } : void 0,
          advancedChunks: {
            // Without this, groups recursively capture dependencies — React
            // itself ends up inside an icon bucket and every window preloads it.
            includeDependenciesRecursively: false,
            groups: [
              // Bucket per-icon lazy modules into mid-size chunks instead of one
              // tiny chunk per icon. Model icons only: they are reached solely
              // through the dynamic loaders, so the buckets stay off every
              // window's eager graph. Provider icons must NOT be grouped — a few
              // files statically import specific providers from
              // @cherrystudio/ui/icons/providers, and bucketing would chain
              // whole buckets of unrelated SVGs into those windows' first load.
              // Only the SVG component files (*.tsx) may match: each icon dir's
              // meta.ts is eagerly imported by the meta-catalogs.
              {
                name: "icons-models",
                test: /packages\/ui\/src\/components\/icons\/models\/[^/]+\/(?:index|light|dark|avatar)\.tsx$/,
                maxSize: 15e4
              }
            ]
          }
        }
      }
    }
  }
});
export {
  electron_vite_config_default as default,
  isMainExternalModule,
  mainExternalModules,
  mainResolveAlias,
  resolveRendererEdition,
  resolveSentryBuildSettings,
  resolveXuelangApiOrigin
};
