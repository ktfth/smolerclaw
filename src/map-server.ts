/**
 * Standalone Lokaliza map server.
 * Lightweight HTTP server for the neighborhood map, runs alongside TUI.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getMapHtml } from './ui/web/map-page'
import {
  listNeighborhoods, getNeighborhood, toGeoJSON, allNeighborhoodsGeoJSON,
} from './neighborhoods'

const MAP_PORT = 3848

let _running = false
let _port = MAP_PORT

export function startMapServer(): void {
  if (_running) return

  const app = new Hono()
  app.use('*', cors())

  // No-cache headers for all responses to prevent stale pages
  app.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
    c.header('Pragma', 'no-cache')
  })

  app.get('/', (c) => c.html(getMapHtml()))
  app.get('/map', (c) => c.html(getMapHtml()))

  app.get('/api/neighborhoods', (c) => {
    const data = listNeighborhoods()
    return c.json(data)
  })

  app.get('/api/neighborhoods/all/geojson', (c) => c.json(allNeighborhoodsGeoJSON()))

  app.get('/api/neighborhoods/:id', (c) => {
    const hood = getNeighborhood(c.req.param('id'))
    if (!hood) return c.json({ error: 'Not found' }, 404)
    return c.json(hood)
  })

  app.get('/api/neighborhoods/:id/geojson', (c) => {
    const hood = getNeighborhood(c.req.param('id'))
    if (!hood) return c.json({ error: 'Not found' }, 404)
    return c.json(toGeoJSON(hood))
  })

  // Try primary port, fall back to next if occupied
  for (let port = MAP_PORT; port < MAP_PORT + 10; port++) {
    try {
      Bun.serve({
        port,
        fetch: (req, server) => app.fetch(req, server),
      })
      _port = port
      _running = true
      console.log(`  Lokaliza mapa: http://localhost:${port}/map`)
      return
    } catch {
      // port in use, try next
    }
  }
}

export function getMapUrl(): string {
  return `http://localhost:${_port}/map`
}

export function isMapServerRunning(): boolean {
  return _running
}
