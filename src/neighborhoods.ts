/**
 * Neighborhood mapping engine — Lokaliza geo analytics.
 * Store, search, and enrich neighborhood data with GeoJSON boundaries,
 * POIs, and data layers for visualization.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './vault'
import { syncRegionalFeeds } from './news'

// ─── Types ──────────────────────────────────────────────────

export type LayerType = 'heatmap' | 'hexbin' | 'arc' | 'scatter' | 'polygon' | 'icon'

export interface GeoPoint {
  lat: number
  lng: number
}

export interface GeoPolygon {
  type: 'Polygon' | 'MultiPolygon'
  coordinates: number[][][] | number[][][][]
}

export interface POI {
  id: string
  name: string
  category: string
  position: GeoPoint
  tags: string[]
  metadata: Record<string, unknown>
  createdAt: string
}

export interface DataLayer {
  id: string
  name: string
  type: LayerType
  color: string
  opacity: number
  visible: boolean
  points: Array<GeoPoint & { value?: number; label?: string; metadata?: Record<string, unknown> }>
}

export interface Neighborhood {
  id: string
  name: string
  city: string
  state: string
  country: string
  center: GeoPoint
  boundary: GeoPolygon | null
  pois: POI[]
  layers: DataLayer[]
  tags: string[]
  population?: number
  area_km2?: number
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface NeighborhoodSearchResult {
  neighborhood: Neighborhood
  score: number
}

// ─── Storage ────────────────────────────────────────────────

let _dataDir = ''
let _neighborhoods: Neighborhood[] = []

const DATA_FILE = () => join(_dataDir, 'neighborhoods.json')

function save(): void {
  atomicWriteFile(DATA_FILE(), JSON.stringify(_neighborhoods, null, 2))
}

function load(): void {
  const file = DATA_FILE()
  if (!existsSync(file)) {
    _neighborhoods = []
    return
  }
  try {
    _neighborhoods = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    _neighborhoods = []
  }
}

// ─── Init ───────────────────────────────────────────────────

export function initNeighborhoods(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  load()
}

// ─── Geocoding (Nominatim/OpenStreetMap — free, no API key) ─

async function geocodeAddress(query: string): Promise<{
  lat: number
  lng: number
  displayName: string
  boundingBox: [number, number, number, number]
} | null> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&polygon_geojson=1`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'smolerclaw/1.7.0' },
    })
    const data = await res.json() as Array<{
      lat: string
      lon: string
      display_name: string
      boundingbox: string[]
      geojson?: { type: string; coordinates: unknown }
    }>
    if (!data.length) return null
    const item = data[0]
    return {
      lat: parseFloat(item.lat),
      lng: parseFloat(item.lon),
      displayName: item.display_name,
      boundingBox: item.boundingbox.map(Number) as [number, number, number, number],
    }
  } catch {
    return null
  }
}

async function fetchBoundary(query: string): Promise<GeoPolygon | null> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&polygon_geojson=1`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'smolerclaw/1.7.0' },
    })
    const data = await res.json() as Array<{
      geojson?: { type: string; coordinates: unknown }
    }>
    if (!data.length || !data[0].geojson) return null
    const geo = data[0].geojson
    if (geo.type === 'Polygon' || geo.type === 'MultiPolygon') {
      return geo as GeoPolygon
    }
    return null
  } catch {
    return null
  }
}

// ─── Auto-enrichment (Overpass API — free, no key) ──────────

interface OverpassElement {
  type: string
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

const POI_QUERIES: Array<{ category: string; osmTag: string }> = [
  { category: 'escola', osmTag: '"amenity"="school"' },
  { category: 'hospital', osmTag: '"amenity"="hospital"' },
  { category: 'posto de saude', osmTag: '"amenity"="clinic"' },
  { category: 'farmacia', osmTag: '"amenity"="pharmacy"' },
  { category: 'delegacia', osmTag: '"amenity"="police"' },
  { category: 'bombeiros', osmTag: '"amenity"="fire_station"' },
  { category: 'supermercado', osmTag: '"shop"="supermarket"' },
  { category: 'estacao de trem', osmTag: '"railway"="station"' },
  { category: 'ponto de onibus', osmTag: '"highway"="bus_stop"' },
  { category: 'parque', osmTag: '"leisure"="park"' },
  { category: 'igreja', osmTag: '"amenity"="place_of_worship"' },
  { category: 'banco', osmTag: '"amenity"="bank"' },
]

async function fetchNearbyPOIs(
  lat: number,
  lng: number,
  radiusMeters: number = 2000,
): Promise<POI[]> {
  const pois: POI[] = []
  const osmQueries = POI_QUERIES.map((q) =>
    `node[${q.osmTag}](around:${radiusMeters},${lat},${lng});way[${q.osmTag}](around:${radiusMeters},${lat},${lng});`
  ).join('')

  const overpassQuery = `[out:json][timeout:15];(${osmQueries});out center 100;`
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'smolerclaw/1.7.0' },
    })
    const data = await res.json() as { elements?: OverpassElement[] }
    if (!data.elements) return pois

    for (const el of data.elements) {
      const elLat = el.lat ?? el.center?.lat
      const elLng = el.lon ?? el.center?.lon
      if (!elLat || !elLng) continue

      const name = el.tags?.name || el.tags?.['name:pt'] || ''
      if (!name) continue

      const category = detectCategory(el.tags ?? {})

      pois.push({
        id: randomUUID().slice(0, 8),
        name,
        category,
        position: { lat: elLat, lng: elLng },
        tags: extractOsmTags(el.tags ?? {}),
        metadata: {
          source: 'openstreetmap',
          osmType: el.type,
          ...pickRelevantTags(el.tags ?? {}),
        },
        createdAt: new Date().toISOString(),
      })
    }
  } catch {
    // Overpass may be rate-limited; fail silently
  }

  return pois
}

function detectCategory(tags: Record<string, string>): string {
  if (tags.amenity === 'school') return 'escola'
  if (tags.amenity === 'hospital') return 'hospital'
  if (tags.amenity === 'clinic') return 'posto de saude'
  if (tags.amenity === 'pharmacy') return 'farmacia'
  if (tags.amenity === 'police') return 'delegacia'
  if (tags.amenity === 'fire_station') return 'bombeiros'
  if (tags.amenity === 'bank') return 'banco'
  if (tags.amenity === 'place_of_worship') return 'igreja'
  if (tags.shop === 'supermarket') return 'supermercado'
  if (tags.railway === 'station') return 'estacao de trem'
  if (tags.highway === 'bus_stop') return 'ponto de onibus'
  if (tags.leisure === 'park') return 'parque'
  return tags.amenity || tags.shop || tags.leisure || 'outro'
}

function extractOsmTags(tags: Record<string, string>): string[] {
  const result: string[] = []
  if (tags.amenity) result.push(tags.amenity)
  if (tags.shop) result.push(tags.shop)
  if (tags.leisure) result.push(tags.leisure)
  if (tags.healthcare) result.push(tags.healthcare)
  if (tags.railway) result.push(tags.railway)
  return result
}

function pickRelevantTags(tags: Record<string, string>): Record<string, string> {
  const keys = ['addr:street', 'addr:housenumber', 'phone', 'website', 'opening_hours', 'operator']
  const result: Record<string, string> = {}
  for (const k of keys) {
    if (tags[k]) result[k] = tags[k]
  }
  return result
}

// ─── CRUD ───────────────────────────────────────────────────

export async function addNeighborhood(
  name: string,
  city: string,
  state: string,
  country: string = 'Brazil',
  tags: string[] = [],
  autoEnrich: boolean = true,
): Promise<Neighborhood> {
  const query = `${name}, ${city}, ${state}, ${country}`
  const geo = await geocodeAddress(query)
  const boundary = await fetchBoundary(query)

  const now = new Date().toISOString()
  const hood: Neighborhood = {
    id: randomUUID().slice(0, 8),
    name,
    city,
    state,
    country,
    center: geo ? { lat: geo.lat, lng: geo.lng } : { lat: 0, lng: 0 },
    boundary,
    pois: [],
    layers: [],
    tags: tags.map((t) => t.toLowerCase()),
    metadata: geo ? { displayName: geo.displayName, boundingBox: geo.boundingBox } : {},
    createdAt: now,
    updatedAt: now,
  }

  // Auto-enrich: fetch nearby POIs from OpenStreetMap
  if (autoEnrich && geo) {
    const nearbyPois = await fetchNearbyPOIs(geo.lat, geo.lng, 3000)
    hood.pois = nearbyPois

    // Auto-create infrastructure density layer from POIs
    if (nearbyPois.length > 0) {
      const categoryGroups = new Map<string, POI[]>()
      for (const poi of nearbyPois) {
        const group = categoryGroups.get(poi.category) ?? []
        categoryGroups.set(poi.category, [...group, poi])
      }

      hood.layers = [
        {
          id: randomUUID().slice(0, 8),
          name: 'Infraestrutura',
          type: 'scatter',
          color: '#00e5cc',
          opacity: 0.8,
          visible: true,
          points: nearbyPois.map((p) => ({
            lat: p.position.lat,
            lng: p.position.lng,
            value: 1,
            label: `${p.name} (${p.category})`,
          })),
        },
      ]

      hood.metadata = {
        ...hood.metadata,
        enrichedAt: now,
        poiBreakdown: Object.fromEntries(
          [...categoryGroups.entries()].map(([cat, pois]) => [cat, pois.length]),
        ),
      }
    }
  }

  _neighborhoods = [..._neighborhoods, hood]
  save()

  // Auto-register regional news feeds for this state
  syncRegionalFeeds([state])

  return hood
}

export function getNeighborhood(idOrName: string): Neighborhood | null {
  return _neighborhoods.find(
    (n) => n.id === idOrName || n.name.toLowerCase() === idOrName.toLowerCase(),
  ) ?? null
}

export function listNeighborhoods(): readonly Neighborhood[] {
  // Lazy reload from disk if memory is empty but file exists (handles init timing)
  if (!_neighborhoods.length && _dataDir && existsSync(DATA_FILE())) {
    load()
  }
  return _neighborhoods
}

export function removeNeighborhood(idOrName: string): boolean {
  const before = _neighborhoods.length
  _neighborhoods = _neighborhoods.filter(
    (n) => n.id !== idOrName && n.name.toLowerCase() !== idOrName.toLowerCase(),
  )
  if (_neighborhoods.length < before) {
    save()
    return true
  }
  return false
}

export function searchNeighborhoods(query: string): NeighborhoodSearchResult[] {
  const q = query.toLowerCase()
  return _neighborhoods
    .map((n) => {
      let score = 0
      if (n.name.toLowerCase().includes(q)) score += 10
      if (n.city.toLowerCase().includes(q)) score += 5
      if (n.tags.some((t) => t.includes(q))) score += 3
      if (n.pois.some((p) => p.name.toLowerCase().includes(q))) score += 2
      return { neighborhood: n, score }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
}

// ─── POI Management ─────────────────────────────────────────

export function addPOI(
  neighborhoodId: string,
  name: string,
  category: string,
  lat: number,
  lng: number,
  tags: string[] = [],
  metadata: Record<string, unknown> = {},
): POI | null {
  const hood = _neighborhoods.find((n) => n.id === neighborhoodId || n.name.toLowerCase() === neighborhoodId.toLowerCase())
  if (!hood) return null

  const poi: POI = {
    id: randomUUID().slice(0, 8),
    name,
    category,
    position: { lat, lng },
    tags: tags.map((t) => t.toLowerCase()),
    metadata,
    createdAt: new Date().toISOString(),
  }

  const updated: Neighborhood = {
    ...hood,
    pois: [...hood.pois, poi],
    updatedAt: new Date().toISOString(),
  }
  _neighborhoods = _neighborhoods.map((n) => (n.id === hood.id ? updated : n))
  save()
  return poi
}

export function removePOI(neighborhoodId: string, poiId: string): boolean {
  const hood = _neighborhoods.find((n) => n.id === neighborhoodId || n.name.toLowerCase() === neighborhoodId.toLowerCase())
  if (!hood) return false

  const before = hood.pois.length
  const updated: Neighborhood = {
    ...hood,
    pois: hood.pois.filter((p) => p.id !== poiId),
    updatedAt: new Date().toISOString(),
  }
  if (updated.pois.length === before) return false

  _neighborhoods = _neighborhoods.map((n) => (n.id === hood.id ? updated : n))
  save()
  return true
}

// ─── Data Layers ────────────────────────────────────────────

export function addLayer(
  neighborhoodId: string,
  name: string,
  type: LayerType,
  color: string = '#00ffcc',
  points: DataLayer['points'] = [],
): DataLayer | null {
  const hood = _neighborhoods.find((n) => n.id === neighborhoodId || n.name.toLowerCase() === neighborhoodId.toLowerCase())
  if (!hood) return null

  const layer: DataLayer = {
    id: randomUUID().slice(0, 8),
    name,
    type,
    color,
    opacity: 0.7,
    visible: true,
    points,
  }

  const updated: Neighborhood = {
    ...hood,
    layers: [...hood.layers, layer],
    updatedAt: new Date().toISOString(),
  }
  _neighborhoods = _neighborhoods.map((n) => (n.id === hood.id ? updated : n))
  save()
  return layer
}

export function addLayerPoints(
  neighborhoodId: string,
  layerId: string,
  points: DataLayer['points'],
): boolean {
  const hood = _neighborhoods.find((n) => n.id === neighborhoodId || n.name.toLowerCase() === neighborhoodId.toLowerCase())
  if (!hood) return false

  const layer = hood.layers.find((l) => l.id === layerId)
  if (!layer) return false

  const updatedLayer: DataLayer = {
    ...layer,
    points: [...layer.points, ...points],
  }
  const updated: Neighborhood = {
    ...hood,
    layers: hood.layers.map((l) => (l.id === layerId ? updatedLayer : l)),
    updatedAt: new Date().toISOString(),
  }
  _neighborhoods = _neighborhoods.map((n) => (n.id === hood.id ? updated : n))
  save()
  return true
}

export function toggleLayerVisibility(neighborhoodId: string, layerId: string): boolean {
  const hood = _neighborhoods.find((n) => n.id === neighborhoodId || n.name.toLowerCase() === neighborhoodId.toLowerCase())
  if (!hood) return false

  const layer = hood.layers.find((l) => l.id === layerId)
  if (!layer) return false

  const updatedLayer: DataLayer = { ...layer, visible: !layer.visible }
  const updated: Neighborhood = {
    ...hood,
    layers: hood.layers.map((l) => (l.id === layerId ? updatedLayer : l)),
    updatedAt: new Date().toISOString(),
  }
  _neighborhoods = _neighborhoods.map((n) => (n.id === hood.id ? updated : n))
  save()
  return true
}

export function removeLayer(neighborhoodId: string, layerId: string): boolean {
  const hood = _neighborhoods.find((n) => n.id === neighborhoodId || n.name.toLowerCase() === neighborhoodId.toLowerCase())
  if (!hood) return false

  const before = hood.layers.length
  const updated: Neighborhood = {
    ...hood,
    layers: hood.layers.filter((l) => l.id !== layerId),
    updatedAt: new Date().toISOString(),
  }
  if (updated.layers.length === before) return false

  _neighborhoods = _neighborhoods.map((n) => (n.id === hood.id ? updated : n))
  save()
  return true
}

// ─── Formatting ─────────────────────────────────────────────

export function formatNeighborhoodList(hoods: readonly Neighborhood[]): string {
  if (!hoods.length) return 'Nenhum bairro cadastrado.'
  return hoods.map((h) => {
    const poiCount = h.pois.length
    const layerCount = h.layers.length
    const tags = h.tags.length ? ` [${h.tags.join(', ')}]` : ''
    return `• ${h.name} — ${h.city}/${h.state}  (${poiCount} POIs, ${layerCount} layers)${tags}  [${h.id}]`
  }).join('\n')
}

export function formatNeighborhoodDetail(h: Neighborhood): string {
  const lines: string[] = [
    `# ${h.name}`,
    `📍 ${h.city}, ${h.state}, ${h.country}`,
    `🗺️ Centro: ${h.center.lat.toFixed(6)}, ${h.center.lng.toFixed(6)}`,
    h.boundary ? `📐 Limite: ${h.boundary.type}` : '📐 Limite: nao disponivel',
    h.population ? `👥 Populacao: ${h.population.toLocaleString('pt-BR')}` : '',
    h.area_km2 ? `📏 Area: ${h.area_km2} km²` : '',
    h.tags.length ? `🏷️ Tags: ${h.tags.join(', ')}` : '',
    '',
    `## POIs (${h.pois.length})`,
    ...h.pois.map((p) => `  • ${p.name} (${p.category}) — ${p.position.lat.toFixed(4)}, ${p.position.lng.toFixed(4)}  [${p.id}]`),
    '',
    `## Layers (${h.layers.length})`,
    ...h.layers.map((l) => `  • ${l.name} (${l.type}) — ${l.points.length} pontos — ${l.visible ? 'visivel' : 'oculto'}  [${l.id}]`),
  ]
  return lines.filter(Boolean).join('\n')
}

// ─── GeoJSON Export (for map UI) ────────────────────────────

export function toGeoJSON(hood: Neighborhood): Record<string, unknown> {
  const features: Record<string, unknown>[] = []

  // Boundary polygon
  if (hood.boundary) {
    features.push({
      type: 'Feature',
      properties: { type: 'boundary', name: hood.name, id: hood.id },
      geometry: hood.boundary,
    })
  }

  // POIs as points
  for (const poi of hood.pois) {
    features.push({
      type: 'Feature',
      properties: {
        type: 'poi',
        name: poi.name,
        category: poi.category,
        id: poi.id,
        tags: poi.tags,
        ...poi.metadata,
      },
      geometry: {
        type: 'Point',
        coordinates: [poi.position.lng, poi.position.lat],
      },
    })
  }

  // Layer points
  for (const layer of hood.layers) {
    if (!layer.visible) continue
    for (const pt of layer.points) {
      features.push({
        type: 'Feature',
        properties: {
          type: 'layer_point',
          layerName: layer.name,
          layerType: layer.type,
          layerId: layer.id,
          color: layer.color,
          value: pt.value,
          label: pt.label,
          ...(pt.metadata ?? {}),
        },
        geometry: {
          type: 'Point',
          coordinates: [pt.lng, pt.lat],
        },
      })
    }
  }

  return {
    type: 'FeatureCollection',
    features,
  }
}

export function allNeighborhoodsGeoJSON(): Record<string, unknown> {
  const features = _neighborhoods.flatMap((hood) => {
    const gj = toGeoJSON(hood)
    return (gj.features as Record<string, unknown>[]) ?? []
  })
  return { type: 'FeatureCollection', features }
}
