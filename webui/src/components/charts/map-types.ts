// Type contract for the <map> custom element.
//
// `<map>` renders a geographic choropleth (regions shaded by data) with an
// optional point/bubble overlay. Like <chart> and <graph>, the agent only
// supplies data — the boundary geometry is owned by the runtime and loaded
// lazily (see map-geo.ts), since the sandbox has no network access.


// === INPUT — what the agent writes ===


export interface MapProps {
  // Which base map to render. v1 ships the world; more atlases later.
  kind?: "world"
  // Choropleth data, one entry per region. Regions not listed render as a
  // neutral "no data" fill.
  data?: MapDatum[]
  // Point overlay (cities, events, sized bubbles) projected by lat/lng.
  markers?: MapMarker[]
  // Token whose intensity encodes `value` across the data (default
  // "chart-1"). Accepts the same palette names as Chart/Graph.
  color?: string
  // CSS height; width always fills the container. Default 320.
  height?: number | string
}


export interface MapDatum {
  // Region key: a country's common English name ("France") or its numeric
  // ISO code ("250"). Unknown keys are dropped with a warning.
  id: string
  // Drives shading intensity of `color` across the dataset. Omit for a
  // flat fill.
  value?: number
  // Explicit fill for this region — overrides `value` shading. Palette
  // name or CSS color.
  color?: string
  // Optional human label (e.g. for future tooltips); unused in v1 render.
  label?: string
}


export interface MapMarker {
  lat: number
  lng: number
  label?: string                    // small caption above the point
  color?: string                    // fill — default token: `chart-1`
  r?: number                        // radius in viewBox units (default 4)
}


// === INTERMEDIATE — what the renderer consumes (post-projection) ===
// Colors are already resolved to CSS; coordinates are in viewBox units. (Regions are
// traced straight from atlas features on the canvas — see map-draw.ts — so no
// serialized-path intermediate is needed.)


export interface ProjectedMarker {
  x: number
  y: number
  label: string | null
  color: string                     // resolved CSS
  r: number
}
