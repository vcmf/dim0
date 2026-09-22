// Pure helpers behind the <map> element: join agent data to atlas regions,
// shade by value, build SVG paths, and project marker coordinates.
//
// Everything here is deterministic given its inputs (the d3-geo projection
// is pure), so it's unit-tested without loading the real atlas. The async
// geometry load + React lifecycle live in map.tsx / map-geo.ts.

import { geoNaturalEarth1 } from "d3-geo"
import type { GeoProjection } from "d3-geo"
import type { Feature, Geometry, GeoJsonProperties } from "geojson"

import { resolveColor } from "./color-token"
import type { MapDatum, MapMarker, ProjectedMarker } from "./map-types"


type GeoFeature = Feature<Geometry, GeoJsonProperties>


// Fill used for a region the agent supplied no data for. Neutral so the
// shaded regions read as "the data".
const NO_DATA_FILL = "var(--muted)"

// Value shading mixes the chosen token into `--muted` between these
// percentages. The floor keeps the lowest-value region visibly colored
// (not indistinguishable from no-data); the ceiling stops at 90% so even
// the max region keeps a hint of surface underneath.
const MIN_SHADE_PCT = 18
const MAX_SHADE_PCT = 90

const DEFAULT_MARKER_COLOR = "chart-1"
const DEFAULT_MARKER_RADIUS = 4


/**
 * Build a `featureId → CSS fill` function from the agent's data.
 *
 * Resolution order per region: explicit `color` wins; else `value` shades
 * the chosen token by its rank in the dataset; else (no value) a flat
 * token fill; regions absent from the data get the no-data fill. `resolve`
 * maps a friendly id (name / ISO) to the atlas's numeric feature id.
 */
export function buildFillResolver(
  data: MapDatum[],
  resolve: (key: string) => string | null,
  colorToken: string = DEFAULT_MARKER_COLOR,
): (featureId: string) => string {
  const byFeature = new Map<string, MapDatum>()
  let min = Infinity
  let max = -Infinity
  for (const d of data) {
    const fid = resolve(d.id)
    if (fid == null) {
      console.warn(`widget-dsl/map: region "${d.id}" not found, dropping`)
      continue
    }
    byFeature.set(fid, d)
    if (d.value != null) {
      if (d.value < min) min = d.value
      if (d.value > max) max = d.value
    }
  }

  const base = resolveColor(colorToken)
  return (featureId: string): string => {
    const d = byFeature.get(featureId)
    if (!d) return NO_DATA_FILL
    if (d.color != null) return resolveColor(d.color)
    if (d.value == null) return base
    // Single-value datasets (or all-equal) shade at full intensity.
    const t = max > min ? (d.value - min) / (max - min) : 1
    const pct = Math.round(MIN_SHADE_PCT + t * (MAX_SHADE_PCT - MIN_SHADE_PCT))
    return `color-mix(in oklch, ${base} ${pct}%, var(--muted))`
  }
}


/** Fit a Natural Earth projection to the given viewBox dimensions. */
export function buildProjection(
  features: GeoFeature[],
  width: number,
  height: number,
): GeoProjection {
  return geoNaturalEarth1().fitSize([width, height], {
    type: "FeatureCollection",
    features,
  })
}


/** Project lat/lng markers into viewBox coordinates, dropping any that
 *  fall outside the projection (e.g. clipped points). */
export function projectMarkers(
  markers: MapMarker[],
  projection: GeoProjection,
): ProjectedMarker[] {
  const out: ProjectedMarker[] = []
  for (const m of markers) {
    const p = projection([m.lng, m.lat])
    if (!p) continue
    out.push({
      x: p[0],
      y: p[1],
      label: m.label ?? null,
      color: resolveColor(m.color ?? DEFAULT_MARKER_COLOR),
      r: m.r ?? DEFAULT_MARKER_RADIUS,
    })
  }
  return out
}
