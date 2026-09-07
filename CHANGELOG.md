## v0.3.93 (2026-09-05)

### Feat

- **models**: route normal to DeepSeek V4 Flash, classifier to gpt-oss-120b (#272)

### Fix

- **board**: restore breadcrumb regressions from #267 (#273)

## v0.3.92 (2026-09-01)

### Feat

- **board**: unify breadcrumbs into a persistent location bar (#267)

## v0.3.91 (2026-09-01)

### Feat

- **auth**: web Google sign-in via redirect (auth-code + PKCE) (#266)

## v0.3.90 (2026-08-31)

### Feat

- **agent**: navigate tool + working folder (off-scene authoring) (#262)
- **agent**: arrange_notes tool for on-demand layout (#257)
- **agent**: relational note placement (near an existing note) (#256)
- **agent**: give the agent spatial context for selected notes (#255)
- **agent**: let the agent set note colors by name (#253)

### Fix

- **board**: sheet @-mentions + subpages on local boards (#265)
- **agent**: land create_folder (S9) on main (#264)
- **sync**: pump deep-layer cascade deletes through the sync intake (#260)
- **board**: unify node freshness stamp so agent notes show Created/Edited (#258)
- **drawify**: use handwriting font for drawn nodes and links (#249)

### Refactor

- **sync**: extract submitLocalBatch as the single local intake (#259)
- **agent**: introduce BoardMutator write port (behavior-neutral) (#250)

## v0.3.89 (2026-08-24)

### Fix

- **board**: place applied mindmaps beneath existing board content (#248)

## v0.3.88 (2026-08-24)

### Refactor

- **board**: rebuild canvas context menu on Radix menu primitives (#247)

## v0.3.87 (2026-08-23)

### Feat

- **prompts**: make skill-loading mandatory before write_note (#241)
- **agent**: surface found notes as clickable citations in chat (#240)
- **webui**: escape returns to select tool, else closes open dialog (#238)

### Fix

- **agent**: re-expand doc source card when its title is cited (#243)
- **webui**: broaden escape overlay guard + restore two-step cancel (#246)
- **repo**: tag release commit with all manifests synced (#242)
- **webui**: note-card/board links use `center` (the consumed nav param) (#239)

## v0.3.86 (2026-08-21)

### Feat

- **webui**: make note search span all folders, not just the current layer (#235)
- **agent**: compact history to a recent tail when the prompt is over budget (#232)
- **agent**: bound tool output intra-run and age it across turns (#231)
- **agent**: derive board purpose + rolling conversation context (#230)
- **agent**: durable board + global memory store and tools (#229)
- **agent**: forward reasoning through the managed transport (#228)
- **agent**: capture streamed reasoning in the browser engine (BYOK) (#227)
- **agent**: inject a deterministic board snapshot into the agent context (#226)

### Fix

- **webui**: make browser-agent note search work (build the index; index titles) (#233)

### Refactor

- **webui**: unify node label to RichText, matching backend (#234)

## v0.3.85 (2026-08-13)

### Fix

- **webui**: scope deferred-mount pool per board + purer, flash-free mount latch (#220)

### Perf

- **webui**: stagger heavy-node mounts via a per-board scheduler (#222)

## v0.3.84 (2026-08-13)

### Perf

- **webui**: defer heavy on-canvas node mounts (mini-apps + sheets) until pan settles (#219)

## v0.3.83 (2026-08-12)

### Perf

- **webui**: cache highlightCodeSync output to cut scroll re-tokenizing (#218)

## v0.3.82 (2026-08-12)

### Perf

- **webui**: suspend off-screen-but-alive mini-app iframes via content-visibility (#216)
- **webui**: prefetch mini-app runtime on idle to warm first open (#217)

## v0.3.81 (2026-08-12)

### Perf

- **webui**: share one mini-app runtime cache entry across themes (#214)
- **webui**: bounded keep-alive for mini-app iframes on scroll (#215)

## v0.3.80 (2026-08-09)

### Feat

- **desktop**: app-styled OAuth sign-in result pages (#213)

## v0.3.79 (2026-08-09)

### Feat

- **webui**: open stripe billing in os browser on desktop (#211)
- **webui**: clarify local-boards link + free-signup tooltips on sign-in CTAs (#212)

## v0.3.78 (2026-08-07)

### Fix

- **desktop**: paint title bar as chrome (sidebar surface + border) (#210)

## v0.3.77 (2026-08-07)

### Fix

- **board**: lighten toolbar hover fill + border vs active state (#209)

## v0.3.76 (2026-08-07)

### Feat

- **dashboard**: reveal sync/share to signed-out users + desktop logout → dashboard (#205)

### Fix

- **backend**: reject the data root itself in file-path confinement guards (F1 follow-up) (#207)
- **board**: show active toolbar button border + view-button hover/active states (#208)
- **board**: require drag-to-size placement, drop single-click node creation (#206)
- **desktop**: derive app version from Cargo.toml, not a stale tauri.conf.json pin (#204)

## v0.3.75 (2026-08-07)

## v0.3.74 (2026-08-07)

### Fix

- **backend**: confine GET /files to the data root (F1 — arbitrary file read) (#201)

## v0.3.73 (2026-08-07)

## v0.3.72 (2026-08-06)

### Perf

- **desktop**: unlock WKWebView 120fps + drop canvas-overlay backdrop-blur on WebKit (#199)

## v0.3.71 (2026-08-06)

### Feat

- **desktop**: frameless window + custom title bar & window controls (#198)

## v0.3.70 (2026-08-06)

### Fix

- **board**: give active topbar buttons the same border as hover (incl. view button) (#197)
- **board**: offline base for already-synced boards, not only pristine ones (#196)

## v0.3.69 (2026-08-06)

### Feat

- **sidebar**: active-row highlight + filled kind icon for the open surface (#195)

### Fix

- **board**: visible hover on top toolbar buttons via border (#194)

## v0.3.68 (2026-08-06)

### Feat

- **board**: whole-board offline materialization for synced boards (PR-1: phases A+B) (#191)
- **board**: expandable sidebar hierarchy + deep-link routes for local boards (#190)

## v0.3.67 (2026-08-04)

### Fix

- **build**: honor ENVFILE in the desktop make targets (#189)

## v0.3.66 (2026-08-04)

### Fix

- **webui**: exclude mini-app from PWA precache (unbreaks build) (#188)

## v0.3.65 (2026-08-04)

### Fix

- **webui**: load self-hosted fonts in the mini-app runtime (#187)

## v0.3.64 (2026-08-04)

### Fix

- **ci**: desktop publish downloads only its own artifacts (#186)

## v0.3.63 (2026-08-03)

### Fix

- **ci**: raise Node heap for desktop builds (macOS runner OOM) (#185)

## v0.3.62 (2026-08-03)

### Fix

- **ci**: build desktop installers from Release, not the tag event (#184)

## v0.3.61 (2026-08-03)

## v0.3.60 (2026-08-03)

### Feat

- **desktop**: standalone Tauri app — offline local + optional remote, with distribution (#178)
- **agent**: browser agent on synced boards + cross-device transcript (Phase 2+3, flag-gated) (#172)

### Fix

- **board**: navigate the open board to the synced route after promoting it (#176)
- **billing**: gate frontend tiers/limits on backend billing_enabled (OSS fix, FE half) (#175)
- **billing**: OSS deploys resolve to plus everywhere (plan reporting matched to enforcement) (#174)
- **board**: default synced boards to the v2 sync engine (Phase 1) (#170)

## v0.3.59 (2026-06-26)

## v0.3.58 (2026-06-26)

### Feat

- **billing**: basic tier, model gating, freemium limits + canvas counters (#153)

## v0.3.57 (2026-06-25)

### Fix

- **billing**: gate paid plan on subscription status (#152)

## v0.3.56 (2026-06-25)

### Feat

- **board**: make code node language-aware with runnable-gated sandbox (#151)
- **models**: key-aware model catalog for minimal-key deploys (#149)

## v0.3.55 (2026-06-21)

### Fix

- **board**: stop phantom text node when dbl-clicking custom node title (#146)

## v0.3.54 (2026-06-21)

### Fix

- **sheet**: code block bg follows --card instead of theme-locked var (#144)
- **embed**: truncate oversized inputs to the embedding token limit (#143)

## v0.3.53 (2026-06-19)

### Feat

- **board**: code-sandbox follows app theme via shared shiki (#140)

### Fix

- **board**: exclude frames from dbl-click text editor + style memory (#142)

## v0.3.52 (2026-06-19)

### Fix

- **board**: icon glyph color tracks theme via textColor → iconColor mirror (#139)

## v0.3.51 (2026-06-18)

## v0.3.50 (2026-06-17)

### Fix

- **webui**: correct theme palette illogics in index.css (#136)
- **editor**: tiptap polish — underline round-trip, autolink, link dedup, toolbar chrome (#134)
- **board**: gate iframe pointer-events on selection so canvas gestures survive (#133)

## v0.3.49 (2026-06-16)

### Feat

- **prompts**: proactive plan agent + node emphasis; switch base plan model (#132)

## v0.3.48 (2026-06-16)

### Feat

- content-fit board visuals, mindmap hubs, border edges, and higher agent turn ceiling (#131)

## v0.3.47 (2026-06-16)

### Fix

- **webui**: stamp arrow-drawn edges at create-time to remove double-undo (#130)

## v0.3.46 (2026-06-15)

### Fix

- **webui**: disable macos trackpad swipe-back via overscroll-behavior (#129)

## v0.3.45 (2026-06-14)

## v0.3.44 (2026-06-14)

### Fix

- **board**: stop space-pan from re-firing focused buttons (#127)

## v0.3.43 (2026-06-14)

### Feat

- **mini-app**: Graph auto-layout, color/overflow fixes, and a Map primitive (#126)

## v0.3.42 (2026-06-14)

### Feat

- decorative textures for empty board, canvas, and auth (#125)

### Fix

- **collab**: persist note label through apply_ops (#124)

## v0.3.41 (2026-06-13)

## v0.3.40 (2026-06-13)

## v0.3.39 (2026-06-13)

### Fix

- **mini-app**: externalize theme bootstrap so it survives the prod CSP (#114)

## v0.3.38 (2026-06-13)

### Fix

- **mini-app**: allowlist mini-app.dim0.net in vite preview Host filter (#113)

## v0.3.37 (2026-06-13)

### Fix

- **mini-app**: allowedHosts:true so vite preview doesn't 403 behind Caddy (#112)

## v0.3.36 (2026-06-13)

## v0.3.35 (2026-06-12)

## v0.3.34 (2026-06-11)

### Fix

- parchment secondary color (#104)

## v0.3.33 (2026-06-11)

### Feat

- mini app iframe runtime (#103)

## v0.3.32 (2026-06-07)

## v0.3.31 (2026-06-07)

### Fix

- sheet breadcrumb and subpage icons (#100)

## v0.3.30 (2026-06-05)

### Feat

- add sheet note icon picker (#99)

## v0.3.29 (2026-06-03)

### Feat

- minor ui fixes and alignments (#98)

## v0.3.28 (2026-06-02)

### Fix

- persist note properties on wire (#97)

## v0.3.27 (2026-06-02)

## v0.3.26 (2026-06-01)

### Fix

- **collab**: only emit dimensions actually in the wire patch (#95)

## v0.3.25 (2026-06-01)

## v0.3.24 (2026-05-31)

### Fix

- **board**: persist viewport on camera event + 200ms debounce (#93)

## v0.3.23 (2026-05-31)

### Feat

- node traffic lights (#92)

## v0.3.22 (2026-05-30)

## v0.3.21 (2026-05-30)

### Feat

- add board collab (#90)

## v0.3.20 (2026-05-28)

### Fix

- **board**: close board-switch race that swapped content between boards (#89)

## v0.3.19 (2026-05-27)

## v0.3.18 (2026-05-26)

### Feat

- **webui**: set free plan board limit to 5 (#87)

## v0.3.17 (2026-05-26)

### Feat

- **board**: double-click to create text node + solid editor surface (#86)

## v0.3.16 (2026-05-26)

### Feat

- markdown view directives (#84)

## v0.3.15 (2026-05-25)

## v0.3.14 (2026-05-25)

### Feat

- canvas harness (#81)

### Fix

-   - dim0StyleToCanvas       opacity: s.opacity (no divide)
  - dim0LinkStyleToCanvas   inherits via spread, fixed automatically
  - canvasStyleToDim0       opacity: s?.opacity ?? 100 (no * 100)
  - canvasEdgeStyleToDim0Link  same

## v0.3.13 (2026-05-11)

### Feat

- theme variants (#78)

## v0.3.12 (2026-05-10)

### Fix

- board empty state copy (#77)

## v0.3.11 (2026-05-09)

### Perf

- migrate dialog to base UI (#76)

## v0.3.10 (2026-05-09)

### Perf

- floating island subscriptions (#75)

## v0.3.9 (2026-05-09)

### Feat

- add forget password reset (#74)

## v0.3.8 (2026-05-08)

### Perf

- content visibility cull (#73)

## v0.3.7 (2026-05-08)

### Perf

- content visibility cull (#72)

## v0.3.6 (2026-05-08)

### Perf

- graph subscriptions and edges (#71)

## v0.3.5 (2026-05-07)

## v0.3.4 (2026-05-07)

### Fix

- **agents**: scope rearrange anchor to current folder, not root board (#69)

## v0.3.3 (2026-05-07)

### Fix

- share postgres pool (#68)

## v0.3.2 (2026-05-04)

## v0.3.1 (2026-05-04)

### Feat

- **edge**: add misalignment style from spider-verse (#66)

## v0.3.0 (2026-05-03)

## v0.2.8 (2026-04-30)

### Fix

- minor fixes improving md editor typing exp (#64)

## v0.2.7 (2026-04-29)

### Fix

- **webui**: preserve transparent picks for node colors (#63)

## v0.2.6 (2026-04-29)

### Fix

- **agents**: inherit root_id as parent_id for new links (#62)

## v0.2.5 (2026-04-28)

### Fix

- improve node layout and fix image-related issues in rich-text nodes (#59)

## v0.2.4 (2026-04-28)

### Feat

- *****: editor polish (#58)

## v0.2.3 (2026-04-26)

## v0.2.2 (2026-04-24)

### Feat

- **board-agent**: add tool steps overview in floating island (#55)

## v0.2.1 (2026-04-22)

### Feat

- *****: add tiptap editor and major ui revamps (#54)

## v0.2.0 (2026-04-22)

### Feat

- *****: add tiptap editor and major ui revamps (#52)

## v0.1.44 (2026-04-12)

### Feat

- *****: add auto model routing - choose best model per task (#49)

## v0.1.43 (2026-04-11)

### Fix

- **backend**: scope parsed document links to sub-board (#48)

## v0.1.42 (2026-04-10)

## v0.1.41 (2026-04-10)

## v0.1.40 (2026-04-09)

### Feat

- *****: add list view and improve perf of widget nodes (#42)

## v0.1.39 (2026-04-08)

### Fix

- **board**: add parent_id to links (#41)

## v0.1.38 (2026-04-08)

## v0.1.37 (2026-04-07)

## v0.1.36 (2026-04-07)

### Feat

- **agent**: show ai limit dialog (#38)

## v0.1.35 (2026-04-07)

### Feat

- **webui**: add legal consent copy to auth screens (#37)

## v0.1.34 (2026-04-07)

## v0.1.33 (2026-04-04)

### Fix

- *****: fix sub-board redirection in agent note tools and copy cut cross-board and sub-board (#35)

## v0.1.32 (2026-04-04)

### Perf

- **agent**: improve history messages context handling (#34)

## v0.1.31 (2026-04-03)

### Fix

- **board**: route ai spark mapify actions correctly (#33)

## v0.1.30 (2026-04-02)

## v0.1.29 (2026-04-02)

## v0.1.28 (2026-04-02)

## v0.1.27 (2026-04-02)

### Feat

- **board**: add write tool and revamp agent front-end (#29)

## v0.1.26 (2026-03-31)

### Feat

- *****: integrate qwen 3.6 plus preview + minor bug fixes + openai prompt caching (#28)

## v0.1.25 (2026-03-30)

## v0.1.24 (2026-03-29)

### Fix

- **board**: persist canonical sheet size (#26)

## v0.1.23 (2026-03-29)

### Fix

- **backend**: allow note tool outputs without labels (#25)

## v0.1.22 (2026-03-29)

### Feat

- *****: add pwa (#24)

## v0.1.21 (2026-03-28)

### Fix

- *****: fix svg and google connect issues (#23)

## v0.1.20 (2026-03-25)

### Fix

- *****: minor small bug fixes (#21)

## v0.1.19 (2026-03-24)

### Fix

- **build**: fix backend docker runtime (#20)

## v0.1.18 (2026-03-24)

### Fix

- **backend**: use uv lock in docker build (#19)

## v0.1.17 (2026-03-24)

### Fix

- **webui**: allow app dim0 host in vite (#18)

## v0.1.16 (2026-03-24)

## v0.1.15 (2026-03-23)

## v0.1.14 (2026-03-23)

### Fix

- *****: board sheet size fix + minor ui fixes (#15)

## v0.1.13 (2026-03-23)

## v0.1.12 (2026-03-23)

## v0.1.11 (2026-03-23)

## v0.1.10 (2026-03-23)

## v0.1.9 (2026-03-22)

### Refactor

- *****: minor renames (#11)

## v0.1.8 (2026-03-22)

## v0.1.7 (2026-03-22)

## v0.1.6 (2026-03-22)

### Feat

- **build**: improve and add dockerization action (#8)

## v0.1.5 (2026-03-22)

### Feat

- **webui**: show app version in sidebar (#7)

## v0.1.4 (2026-03-22)

### Fix

- **board**: refine linear note behavior (#6)

## v0.1.3 (2026-03-21)

## v0.1.2 (2026-03-21)

## v0.1.1 (2026-03-21)

## v0.1.0 (2026-03-21)

### Feat

- *****: setup semantic versioning (#2)
- *****: first commit (#1)
