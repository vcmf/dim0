import path from "path"
import { readFileSync, readdirSync, statSync } from "fs"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { visualizer } from "rollup-plugin-visualizer"
import { VitePWA } from "vite-plugin-pwa"

const packageJson = JSON.parse(
  readFileSync(path.resolve(__dirname, "./package.json"), "utf8")
) as { version?: string }
const appVersion = packageJson.version ?? "0.0.0"
const shouldAnalyzeBundle = process.env.ANALYZE === "true"
// Vite preview Host-header allowlist. Applies to BOTH the host bundle
// (served at app.dim0.net) AND the mini-app iframe runtime (served at
// mini-app.dim0.net) — docker-entrypoint.sh runs `vite preview` for
// each bundle without passing `--config`, so both processes load this
// single config file and share its `preview.allowedHosts`. Forgetting
// `mini-app.dim0.net` here makes Caddy → vite reverse-proxy 403 the
// iframe runtime ("Host not allowed"), while the host bundle keeps
// working — easy to miss.
const allowedHosts = [
  "app.dim0.net",
  "mini-app.dim0.net",
]


/**
 * Icon names listed in the lazy picker's category entries. Extracted via
 * regex on `name: "Foo"` patterns inside picker-set.ts so the build stays
 * in sync without a separate registry file.
 */
const PICKER_ICON_NAMES = (() => {
  const content = readFileSync(
    path.resolve(__dirname, "src/components/icons/picker-set.ts"),
    "utf8",
  )
  return new Set(
    [...content.matchAll(/name:\s*"([A-Z][a-zA-Z]+)"/g)].map((m) => m[1]),
  )
})()


/**
 * Best-effort scan: every `FooIcon` token in files that import from
 * `@phosphor-icons/react` outside the lazily-loaded picker code. Treated
 * as a superset of icons that must stay in the eager `phosphor` chunk —
 * false positives are harmless (they just keep an icon eager). Skips
 * the picker module files themselves so their 261 named imports don't
 * mark every picker icon as "eager."
 */
const EAGER_PHOSPHOR_NAMES = (() => {
  const names = new Set<string>()
  const SKIP_FILES = new Set([
    "picker-set.ts",
    "icon-picker.tsx",
    "icon-property-view.tsx",
  ])

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue
      if (SKIP_FILES.has(entry)) continue
      const text = readFileSync(full, "utf8")
      if (!text.includes("@phosphor-icons/react")) continue
      for (const m of text.matchAll(/\b([A-Z][a-zA-Z]+)Icon\b/g)) {
        names.add(m[1])
      }
    }
  }

  walk(path.resolve(__dirname, "src"))
  return names
})()


/**
 * Picker icons that are NOT eagerly used anywhere else in the app —
 * safe to route into the lazy `phosphor-picker` chunk so they don't
 * inflate the eager `phosphor` chunk loaded on first paint.
 */
const PICKER_ONLY_ICON_NAMES = new Set(
  [...PICKER_ICON_NAMES].filter((name) => !EAGER_PHOSPHOR_NAMES.has(name)),
)


export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    shouldAnalyzeBundle && visualizer({
      filename: "dist/stats.html",
      gzipSize: true,
      brotliSize: true,
      template: "treemap",
    }),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [
        "favicon-16x16.png",
        "favicon-32x32.png",
        "apple-touch-icon.png",
        "dim0.svg",
      ],
      manifest: {
        name: "Dim0",
        short_name: "Dim0",
        description: "Visual workspace for boards, notes, and agent-assisted thinking.",
        theme_color: "#f7f1e8",
        background_color: "#f7f1e8",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
      workbox: {
        // SPA offline routing: serve the app shell for any deep link (e.g.
        // /local/:id) when offline so client-side routing can take over.
        navigateFallback: "/index.html",
        // …but NOT for the same-origin mini-app iframe runtime (/mini-app/*).
        // It's a real document, not an SPA route — without this the nav fallback
        // serves the host app shell into the iframe once the SW is active, so
        // every mini-app would render the host app instead of the widget.
        navigateFallbackDenylist: [/^\/mini-app\//],
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        // Never precache these — both would trip Workbox's 2 MiB cache-entry
        // limit and (because that's fatal here) fail the prod build:
        //  - stats.html: the ANALYZE=true bundle visualizer, irrelevant at runtime.
        //  - mini-app/**: the iframe runtime is one self-inlined ~5 MB file
        //    (fonts + JS + CSS). Too big to precache; cached at runtime below
        //    instead, so it still works offline after first load.
        globIgnores: ["**/stats.html", "mini-app/**"],
        // Runtime-cache the mini-app runtime (excluded from precache above) so it
        // loads offline. StaleWhileRevalidate: instant from cache, refreshed in
        // the background so a redeploy propagates on the next load.
        //
        // Two distinct assets live under /mini-app/: the 5.4 MB `index.html` and
        // the tiny `theme-bootstrap.js` it loads. They MUST use separate caches —
        // a single cache with `maxEntries: 1` would make them evict each other,
        // re-downloading the 5.4 MB doc on every load and breaking offline.
        runtimeCaching: [
          {
            // The 5.4 MB runtime document. Its src carries `?theme=&mode=` (read
            // by theme-bootstrap.js for first-paint), but the served bytes are
            // theme-independent — the same static file. `ignoreSearch` matches
            // every palette/mode variant to ONE entry (downloaded once, shared,
            // no cold fetch per theme); `maxEntries: 1` keeps just that single
            // byte-identical copy. This rule is registered first, so index.html
            // is handled here and never falls through to the catch-all below.
            urlPattern: /\/mini-app\/index\.html/,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "mini-app-runtime",
              matchOptions: { ignoreSearch: true },
              expiration: { maxEntries: 1 },
            },
          },
          {
            // Everything else under /mini-app/ (theme-bootstrap.js today, plus any
            // future sidecar asset) — a separate cache so it can never evict the
            // runtime document above. Bounded, and offline-safe.
            urlPattern: /\/mini-app\//,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "mini-app-assets",
              expiration: { maxEntries: 16 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * Groups heavy third-party packages into stable chunks so route code
         * stays smaller and bundle analysis is easier to reason about.
         */
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@hugeicons")) return "hugeicons"
            if (id.includes("lucide-react")) return "lucide"
            if (id.includes("@lobehub/icons")) return "lobehub-icons"
            if (id.includes("simple-icons")) return "simple-icons"
            // Phosphor icons used ONLY by the lazy picker get their own
            // chunk so the eager `phosphor` chunk (chrome icons) doesn't
            // carry weight that only matters when the picker opens. The
            // picker-only set is auto-derived from `picker-set.ts` and a
            // src/ scan above. Icons used by both chrome and picker stay
            // in the eager chunk to avoid eagerly-loading two chunks.
            if (
              id.includes("@phosphor-icons/react/dist/csr/") ||
              id.includes("@phosphor-icons/react/dist/defs/")
            ) {
              const m = id.match(/\/(?:csr|defs)\/([A-Za-z]+)\.es\.js$/)
              if (m && PICKER_ONLY_ICON_NAMES.has(m[1])) return "phosphor-picker"
            }
            if (id.includes("@phosphor-icons")) return "phosphor"
            if (id.includes("@iconify")) return "iconify"
            if (id.includes("@tanstack")) return "tanstack"
            if (id.includes("@dagrejs")) return "dagre"
            if (id.includes("@radix-ui")) return "radix"
            if (id.includes("@base-ui")) return "base-ui"
            if (id.includes("@dnd-kit")) return "dnd-kit"
            if (id.includes("d3")) return "d3"
            if (id.includes("@milkdown")) return "milkdown"
            if (id.includes("@lezer")) return "lezer"
            if (id.includes("@codemirror")) return "codemirror"
            if (id.includes("/node_modules/motion/") || id.includes("framer-motion")) return "motion"
            if (id.includes("recharts")) return "recharts"
            if (id.includes("/node_modules/@tiptap/") || id.includes("/node_modules/tiptap-markdown/")) return "tiptap"
            if (
              id.includes("/node_modules/prosemirror-") ||
              id.includes("/node_modules/@prosemirror/") ||
              id.includes("/node_modules/prosemirror/")
            ) return "prosemirror"
            if (
              id.includes("/node_modules/react-markdown/") ||
              id.includes("/node_modules/streamdown/") ||
              id.includes("/node_modules/@streamdown/") ||
              id.includes("/node_modules/remark-") ||
              id.includes("/node_modules/rehype-") ||
              id.includes("/node_modules/hast-util-") ||
              id.includes("/node_modules/mdast-util-") ||
              id.includes("/node_modules/micromark") ||
              id.includes("/node_modules/markdown-it") ||
              id.includes("/node_modules/unified/") ||
              id.includes("/node_modules/unist-util-")
            ) return "markdown"
            if (id.includes("roughjs")) return "roughjs"
            if (id.includes("katex")) return "katex"
            if (id.includes("@xyflow/react")) return "reactflow"
            if (id.includes("chevrotain")) return "chevrotain"
            if (id.includes("cytoscape-fcose")) return "cytoscape-fcose"
            if (id.includes("/node_modules/mermaid/")) return "mermaid"
            if (id.includes("/node_modules/cytoscape/")) return "cytoscape"
            // Large deps that were previously falling into the monolithic `index`
            // chunk (pushing it past the 2 MiB PWA-precache limit). Split each into its
            // own stable chunk — eager ones just move out of `index` (no single file
            // over the limit), lazy-only ones (chart.js/snapdom) stay lazy.
            if (id.includes("/node_modules/@canvas-harness/")) return "canvas-harness"
            if (id.includes("/node_modules/sucrase/")) return "sucrase"
            if (id.includes("/node_modules/@tailwindcss/")) return "tailwind-runtime"
            // NOTE: do NOT force shiki into one chunk — it lazy-loads each language
            // grammar as its own dynamic chunk (cpp, emacs-lisp, …); consolidating them
            // produces a ~9.5 MB blob. Leave shiki to rollup's default splitting.
            if (id.includes("/node_modules/@lottiefiles/")) return "lottie"
            if (id.includes("/node_modules/openai/")) return "openai"
            if (id.includes("/node_modules/acorn/") || id.includes("/node_modules/acorn-jsx/")) return "acorn"
            if (id.includes("/node_modules/@orama/")) return "orama"
            if (id.includes("/node_modules/chart.js/") || id.includes("/node_modules/@kurkle/")) return "chartjs"
            if (id.includes("/node_modules/@zumer/snapdom/")) return "snapdom"
            if (id.includes("/node_modules/html-to-image/")) return "html-to-image"
            if (id.includes("/node_modules/streamdown/") || id.includes("/node_modules/@streamdown/")) return "streamdown"
            if (id.includes("/node_modules/world-atlas/") || id.includes("/node_modules/topojson-client/")) return "geo-atlas"
            if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react"
          }
        },
      },
    },
  },
  server: {
    allowedHosts,
    host: "0.0.0.0",
    port: Number(process.env.APP_PORT) || 5173,
  },
  preview: {
    allowedHosts,
    host: "0.0.0.0",
    port: Number(process.env.APP_PORT) || 5173,
  },
})
