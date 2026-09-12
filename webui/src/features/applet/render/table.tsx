// The applet <Table> component (applet-design.md §7). A themed, optionally
// sortable data table driven by plain `columns` + `rows` data — so the agent
// supplies data, not table markup. Registered as `Table` in the applet renderer.

import { useMemo, useState } from "react"

import { cn } from "@/lib/utils"


type Column = string | { key: string; label?: string }


interface TableProps {
  columns: Column[]
  rows: Array<Record<string, unknown>>
  sortable?: boolean
  className?: string
}


/** Normalize a column (string shorthand or object) to a { key, label } pair. */
function normalize(col: Column): { key: string; label: string } {
  return typeof col === "string" ? { key: col, label: col } : { key: col.key, label: col.label ?? col.key }
}


/** A total order over cell values: nullish sorts first, numbers numerically,
 *  everything else by string — so mixed/missing cells sort consistently. */
function compareCells(x: unknown, y: unknown): number {
  if (x === y) return 0
  if (x === null || x === undefined) return y === null || y === undefined ? 0 : -1
  if (y === null || y === undefined) return 1
  if (typeof x === "number" && typeof y === "number") return x - y
  const sx = String(x)
  const sy = String(y)
  return sx < sy ? -1 : sx > sy ? 1 : 0
}


/** Render a data table; when `sortable`, clicking a header sorts by that column. */
export function Table({ columns, rows, sortable, className }: TableProps) {
  const cols = useMemo(() => (columns ?? []).map(normalize), [columns])
  const [sort, setSort] = useState<{ key: string; asc: boolean } | null>(null)

  const sorted = useMemo(() => {
    if (!sort) return rows ?? []
    const dir = sort.asc ? 1 : -1
    return [...(rows ?? [])].sort((a, b) => compareCells(a[sort.key], b[sort.key]) * dir)
  }, [rows, sort])

  const onHeader = (key: string): void => {
    if (!sortable) return
    setSort((prev) => (prev && prev.key === key ? { key, asc: !prev.asc } : { key, asc: true }))
  }

  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            {cols.map((c) => (
              <th
                key={c.key}
                onClick={() => onHeader(c.key)}
                className={cn("px-2 py-1 font-medium", sortable && "cursor-pointer select-none")}
              >
                {c.label}
                {sort?.key === c.key ? (sort.asc ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={i} className="border-b last:border-0">
              {cols.map((c) => (
                <td key={c.key} className="px-2 py-1">
                  {String(row[c.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
