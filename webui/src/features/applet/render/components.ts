// Maps applet component names to their React implementations (applet-design.md
// §7). The renderer looks a tag up here first; anything not here falls back to a
// whitelisted HTML intrinsic. The keys must stay in sync with `registry.COMPONENTS`.

import type { ComponentType } from "react"

import { GraphElement, MapElement } from "@/components/charts"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"

import { AppletChart } from "./chart/applet-chart"
import { Table } from "./table"


type AnyComponent = ComponentType<Record<string, unknown>>


// Each component has its own strict prop type; the renderer passes validated
// props as a generic record, so the map is typed loosely (one cast, not per-key).
export const COMPONENT_IMPLS = {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
  Button,
  Chart: AppletChart, // Chart.js (canvas) — snapshot-ready; recharts ChartElement kept for legacy
  Graph: GraphElement,
  Map: MapElement,
  Table,
} as unknown as Record<string, AnyComponent>
