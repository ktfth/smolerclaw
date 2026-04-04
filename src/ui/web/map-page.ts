/**
 * Lokaliza — neighborhood map page.
 * Uses deck.gl (CDN) + MapLibre GL JS for 3D data visualization.
 * All UI text in Portuguese (pt-BR).
 */

export function getMapHtml(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lokaliza — Mapa</title>
  <script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
  <link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet" />
  <script src="https://unpkg.com/deck.gl@9.1.4/dist.min.js"></script>
  <style>
    :root {
      --bg: #0a0e14;
      --panel: #0d1117;
      --panel-border: #1c2333;
      --text: #c5d0dc;
      --text-dim: #5c6773;
      --accent: #00e5cc;
      --accent2: #0084ff;
      --danger: #f85149;
      --warning: #d29922;
      --font: 'SF Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    html, body {
      width: 100%; height: 100%;
      font-family: var(--sans);
      background: var(--bg);
      color: var(--text);
      overflow: hidden;
    }

    #map { width: 100%; height: 100%; position: absolute; top: 0; left: 0; }

    /* ── Sidebar ── */
    #sidebar {
      position: absolute; top: 0; left: 0;
      width: 340px; height: 100%;
      background: var(--panel);
      border-right: 1px solid var(--panel-border);
      z-index: 10;
      display: flex; flex-direction: column;
      transition: transform 0.3s ease;
    }
    #sidebar.collapsed { transform: translateX(-340px); }

    #sidebar-toggle {
      position: absolute;
      top: 12px;
      left: 340px;
      z-index: 11;
      background: var(--panel);
      border: 1px solid var(--panel-border);
      color: var(--accent);
      width: 32px; height: 32px;
      border-radius: 0 6px 6px 0;
      cursor: pointer;
      font-size: 14px;
      display: flex; align-items: center; justify-content: center;
      transition: left 0.3s ease;
    }
    #sidebar.collapsed + #sidebar-toggle { left: 0; }

    .sidebar-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--panel-border);
      display: flex; align-items: center; gap: 10px;
    }
    .sidebar-header h1 {
      font-family: var(--font);
      font-size: 14px;
      font-weight: 600;
      color: var(--accent);
      letter-spacing: 1px;
      text-transform: uppercase;
    }
    .sidebar-header .logo {
      width: 8px; height: 8px;
      background: var(--accent);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--accent);
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 8px var(--accent); }
      50% { box-shadow: 0 0 16px var(--accent), 0 0 24px rgba(0, 229, 204, 0.3); }
    }

    .sidebar-section {
      padding: 12px 20px;
      border-bottom: 1px solid var(--panel-border);
    }
    .sidebar-section h2 {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--text-dim);
      margin-bottom: 10px;
    }

    .hood-item {
      padding: 8px 12px;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 4px;
      transition: background 0.15s;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .hood-item:hover { background: rgba(0, 229, 204, 0.08); }
    .hood-item.active { background: rgba(0, 229, 204, 0.15); border-left: 2px solid var(--accent); }
    .hood-item .dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--accent);
      flex-shrink: 0;
    }
    .hood-item .name {
      font-size: 13px;
      font-weight: 500;
    }
    .hood-item .meta {
      font-size: 11px;
      color: var(--text-dim);
      margin-left: auto;
    }

    .layer-item {
      padding: 6px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .layer-item:hover { background: rgba(255,255,255,0.04); }
    .layer-swatch {
      width: 12px; height: 12px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .layer-item .type-badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(255,255,255,0.06);
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-left: auto;
    }
    .layer-item.hidden { opacity: 0.4; }

    .scroll-area {
      flex: 1;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: #1c2333 transparent;
    }

    /* ── Info card (detail view) ── */
    .info-card {
      padding: 12px;
      background: rgba(0, 229, 204, 0.04);
      border: 1px solid rgba(0, 229, 204, 0.12);
      border-radius: 6px;
      margin-top: 8px;
    }
    .info-row {
      display: flex; justify-content: space-between;
      font-size: 11px; padding: 3px 0;
    }
    .info-row .k { color: var(--text-dim); }
    .info-row .v { color: var(--accent); font-family: var(--font); }

    /* ── HUD overlay ── */
    #hud {
      position: absolute;
      top: 12px; right: 12px;
      z-index: 10;
      display: flex; flex-direction: column; gap: 8px;
      align-items: flex-end;
    }
    .hud-card {
      background: rgba(13, 17, 23, 0.85);
      backdrop-filter: blur(12px);
      border: 1px solid var(--panel-border);
      border-radius: 8px;
      padding: 10px 14px;
      font-family: var(--font);
      font-size: 11px;
      min-width: 180px;
    }
    .hud-card .label {
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 1px;
      font-size: 9px;
      margin-bottom: 4px;
    }
    .hud-card .value {
      color: var(--accent);
      font-size: 13px;
      font-weight: 600;
    }

    /* ── Status bar ── */
    #status-bar {
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: 28px;
      background: var(--panel);
      border-top: 1px solid var(--panel-border);
      z-index: 10;
      display: flex;
      align-items: center;
      padding: 0 16px;
      font-family: var(--font);
      font-size: 11px;
      color: var(--text-dim);
      gap: 16px;
    }
    #status-bar .sep {
      width: 1px; height: 14px;
      background: var(--panel-border);
    }
    #status-bar .live-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--accent);
      animation: pulse 2s ease-in-out infinite;
    }

    /* ── Loading ── */
    #loading {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: var(--bg);
      z-index: 100;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      transition: opacity 0.5s;
    }
    #loading.hidden { opacity: 0; pointer-events: none; }
    .spinner {
      width: 40px; height: 40px;
      border: 2px solid var(--panel-border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text {
      font-family: var(--font);
      font-size: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 2px;
    }

    /* ── Tooltip ── */
    .deck-tooltip {
      background: rgba(13, 17, 23, 0.92) !important;
      backdrop-filter: blur(12px);
      border: 1px solid var(--panel-border) !important;
      border-radius: 6px !important;
      padding: 8px 12px !important;
      font-family: var(--font) !important;
      font-size: 11px !important;
      color: var(--text) !important;
      max-width: 280px;
    }

    /* ── Empty state ── */
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-dim);
    }
    .empty-state .icon { font-size: 32px; margin-bottom: 12px; }
    .empty-state p { font-size: 12px; line-height: 1.6; }
    .empty-state code {
      background: rgba(255,255,255,0.06);
      padding: 2px 6px;
      border-radius: 3px;
      font-family: var(--font);
      font-size: 11px;
    }
  </style>
</head>
<body>

<div id="loading">
  <div class="spinner"></div>
  <div class="loading-text">Inicializando mapa</div>
</div>

<div id="map"></div>

<div id="sidebar">
  <div class="sidebar-header">
    <div class="logo"></div>
    <h1>Bairros</h1>
  </div>
  <div class="scroll-area">
    <div class="sidebar-section" id="hood-list-section">
      <h2>Cadastrados</h2>
      <div id="hood-list"></div>
    </div>
    <div class="sidebar-section" id="detail-section" style="display:none">
      <h2>Detalhes</h2>
      <div id="detail-card"></div>
    </div>
    <div class="sidebar-section" id="layer-list-section">
      <h2>Camadas de Dados</h2>
      <div id="layer-list"></div>
    </div>
    <div class="sidebar-section" id="poi-list-section">
      <h2>Pontos de Interesse</h2>
      <div id="poi-list"></div>
    </div>
  </div>
</div>
<button id="sidebar-toggle" title="Alternar painel">&laquo;</button>

<div id="hud">
  <div class="hud-card">
    <div class="label">Bairros</div>
    <div class="value" id="hud-count">0</div>
  </div>
  <div class="hud-card">
    <div class="label">Coordenadas</div>
    <div class="value" id="hud-cursor">&mdash;</div>
  </div>
</div>

<div id="status-bar">
  <div class="live-dot"></div>
  <span id="status-text">Pronto</span>
  <div class="sep"></div>
  <span id="status-zoom">Zoom: &mdash;</span>
  <div class="sep"></div>
  <span>Lokaliza</span>
</div>

<script>
(function() {
  const API = window.location.origin;
  let neighborhoods = [];
  let selectedHoodId = null;
  let mapInstance = null;
  let deckOverlay = null;

  // ── Init MapLibre ──
  mapInstance = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      name: 'Dark',
      sources: {
        'osm-tiles': {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '&copy; OpenStreetMap',
        },
      },
      layers: [
        {
          id: 'osm-tiles',
          type: 'raster',
          source: 'osm-tiles',
          paint: {
            'raster-saturation': -0.6,
            'raster-brightness-min': 0.12,
            'raster-brightness-max': 0.55,
            'raster-contrast': 0.15,
          },
        },
      ],
    },
    center: [-46.6333, -23.5505],
    zoom: 11,
    pitch: 45,
    bearing: -15,
    antialias: true,
  });

  mapInstance.on('load', () => {
    document.getElementById('loading').classList.add('hidden');
    loadData();
  });

  // Fallback: if tiles fail, still load data
  setTimeout(() => {
    document.getElementById('loading').classList.add('hidden');
    if (!neighborhoods.length) loadData();
  }, 3000);

  mapInstance.on('move', () => {
    document.getElementById('status-zoom').textContent = 'Zoom: ' + mapInstance.getZoom().toFixed(1);
  });

  mapInstance.on('mousemove', (e) => {
    document.getElementById('hud-cursor').textContent =
      e.lngLat.lat.toFixed(5) + ', ' + e.lngLat.lng.toFixed(5);
  });

  // ── Fetch data ──
  async function loadData() {
    const url = API + '/api/neighborhoods';
    try {
      const res = await fetch(url);
      if (!res.ok) {
        document.getElementById('status-text').textContent = 'Erro da API: ' + res.status;
        return;
      }
      neighborhoods = await res.json();
      if (!Array.isArray(neighborhoods)) {
        document.getElementById('status-text').textContent = 'Dados invalidos da API';
        neighborhoods = [];
        return;
      }
      renderSidebar();
      renderMap();
      document.getElementById('hud-count').textContent = neighborhoods.length;
      document.getElementById('status-text').textContent = neighborhoods.length + ' bairro(s) carregado(s)';

      // Auto-center on first load if we have data
      if (neighborhoods.length && !selectedHoodId) {
        selectedHoodId = neighborhoods[0].id;
        const h = neighborhoods[0];
        if (h.center.lat) {
          mapInstance.flyTo({ center: [h.center.lng, h.center.lat], zoom: 13, pitch: 50, duration: 2000 });
        }
        renderSidebar();
      }
    } catch (err) {
      document.getElementById('status-text').textContent = 'Erro de conexao: ' + (err.message || err);
      console.error('loadData:', url, err);
    }
  }

  // ── Sidebar ──
  function renderSidebar() {
    const list = document.getElementById('hood-list');
    const layerList = document.getElementById('layer-list');
    const poiList = document.getElementById('poi-list');
    const detailSection = document.getElementById('detail-section');
    const detailCard = document.getElementById('detail-card');

    if (!neighborhoods.length) {
      list.innerHTML = '<div class="empty-state">' +
        '<div class="icon">&#x1F5FA;</div>' +
        '<p>Nenhum bairro cadastrado.<br><br>' +
        'Use o assistente IA:<br>' +
        '<code>add_neighborhood</code></p></div>';
      layerList.innerHTML = '';
      poiList.innerHTML = '';
      detailSection.style.display = 'none';
      return;
    }

    list.innerHTML = neighborhoods.map(h =>
      '<div class="hood-item' + (h.id === selectedHoodId ? ' active' : '') +
      '" data-id="' + h.id + '">' +
      '<div class="dot"></div>' +
      '<span class="name">' + esc(h.name) + '</span>' +
      '<span class="meta">' + esc(h.city) + '</span>' +
      '</div>'
    ).join('');

    list.querySelectorAll('.hood-item').forEach(el => {
      el.addEventListener('click', () => {
        selectedHoodId = el.dataset.id;
        const hood = neighborhoods.find(n => n.id === selectedHoodId);
        if (hood && hood.center.lat) {
          mapInstance.flyTo({ center: [hood.center.lng, hood.center.lat], zoom: 14, pitch: 50, duration: 1500 });
        }
        renderSidebar();
        renderMap();
      });
    });

    // Detail card for selected
    const selected = neighborhoods.find(n => n.id === selectedHoodId) || neighborhoods[0];
    if (selected) {
      detailSection.style.display = '';
      detailCard.innerHTML =
        '<div class="info-card">' +
        '<div class="info-row"><span class="k">Nome</span><span class="v">' + esc(selected.name) + '</span></div>' +
        '<div class="info-row"><span class="k">Cidade</span><span class="v">' + esc(selected.city) + '/' + esc(selected.state) + '</span></div>' +
        '<div class="info-row"><span class="k">Centro</span><span class="v">' + selected.center.lat.toFixed(4) + ', ' + selected.center.lng.toFixed(4) + '</span></div>' +
        '<div class="info-row"><span class="k">Limite</span><span class="v">' + (selected.boundary ? selected.boundary.type : 'N/A') + '</span></div>' +
        '<div class="info-row"><span class="k">POIs</span><span class="v">' + selected.pois.length + '</span></div>' +
        '<div class="info-row"><span class="k">Camadas</span><span class="v">' + selected.layers.length + '</span></div>' +
        (selected.tags.length ? '<div class="info-row"><span class="k">Tags</span><span class="v">' + esc(selected.tags.join(', ')) + '</span></div>' : '') +
        '</div>';

      layerList.innerHTML = selected.layers.length
        ? selected.layers.map(l =>
          '<div class="layer-item' + (l.visible ? '' : ' hidden') + '" data-layer="' + l.id + '" data-hood="' + selected.id + '">' +
          '<div class="layer-swatch" style="background:' + esc(l.color) + '"></div>' +
          '<span>' + esc(l.name) + '</span>' +
          '<span class="type-badge">' + l.type + '</span>' +
          '</div>'
        ).join('')
        : '<div style="font-size:12px;color:var(--text-dim);padding:8px 12px;">Sem camadas</div>';

      poiList.innerHTML = selected.pois.length
        ? selected.pois.map(p =>
          '<div class="layer-item">' +
          '<div class="layer-swatch" style="background:#ff6b6b"></div>' +
          '<span>' + esc(p.name) + '</span>' +
          '<span class="type-badge">' + esc(p.category) + '</span>' +
          '</div>'
        ).join('')
        : '<div style="font-size:12px;color:var(--text-dim);padding:8px 12px;">Sem pontos</div>';
    } else {
      detailSection.style.display = 'none';
    }
  }

  // ── Render deck.gl layers ──
  function renderMap() {
    if (!window.deck) return;

    const layers = [];

    neighborhoods.forEach(hood => {
      // Boundary polygon
      if (hood.boundary) {
        const coords = hood.boundary.type === 'Polygon'
          ? [hood.boundary.coordinates]
          : hood.boundary.coordinates;

        layers.push(new deck.PolygonLayer({
          id: 'boundary-' + hood.id,
          data: coords,
          getPolygon: d => d,
          getFillColor: hood.id === selectedHoodId ? [0, 229, 204, 30] : [0, 132, 255, 20],
          getLineColor: hood.id === selectedHoodId ? [0, 229, 204, 200] : [0, 132, 255, 120],
          getLineWidth: hood.id === selectedHoodId ? 3 : 1,
          lineWidthUnits: 'pixels',
          filled: true,
          stroked: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [0, 229, 204, 60],
        }));
      }

      // POIs
      if (hood.pois.length) {
        layers.push(new deck.ScatterplotLayer({
          id: 'pois-' + hood.id,
          data: hood.pois,
          getPosition: d => [d.position.lng, d.position.lat],
          getFillColor: [255, 107, 107, 200],
          getLineColor: [255, 255, 255, 100],
          getRadius: 40,
          radiusMinPixels: 4,
          radiusMaxPixels: 12,
          lineWidthMinPixels: 1,
          stroked: true,
          filled: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 107, 107, 120],
        }));
      }

      // Data layers
      hood.layers.forEach(layer => {
        if (!layer.visible || !layer.points.length) return;

        const colorArr = hexToRgb(layer.color);

        switch (layer.type) {
          case 'heatmap':
            layers.push(new deck.HeatmapLayer({
              id: 'heat-' + layer.id,
              data: layer.points,
              getPosition: d => [d.lng, d.lat],
              getWeight: d => d.value || 1,
              radiusPixels: 60,
              intensity: 1.5,
              threshold: 0.1,
              colorRange: [
                [0, 0, 0, 0],
                [...colorArr.slice(0,3), 40],
                [...colorArr.slice(0,3), 100],
                [...colorArr.slice(0,3), 160],
                [...colorArr.slice(0,3), 220],
                [...colorArr.slice(0,3), 255],
              ],
              pickable: false,
            }));
            break;

          case 'hexbin':
            layers.push(new deck.HexagonLayer({
              id: 'hex-' + layer.id,
              data: layer.points,
              getPosition: d => [d.lng, d.lat],
              getElevationWeight: d => d.value || 1,
              getColorWeight: d => d.value || 1,
              radius: 100,
              elevationScale: 20,
              extruded: true,
              colorRange: [
                [1, 152, 189], [73, 227, 206],
                [216, 254, 181], [254, 237, 177],
                [254, 173, 84], [209, 55, 78],
              ],
              pickable: true,
              opacity: layer.opacity,
            }));
            break;

          case 'scatter':
            layers.push(new deck.ScatterplotLayer({
              id: 'scatter-' + layer.id,
              data: layer.points,
              getPosition: d => [d.lng, d.lat],
              getFillColor: [...colorArr.slice(0,3), Math.round(layer.opacity * 255)],
              getRadius: d => Math.max(20, (d.value || 1) * 10),
              radiusMinPixels: 3,
              radiusMaxPixels: 30,
              pickable: true,
              autoHighlight: true,
            }));
            break;

          case 'arc':
            if (layer.points.length >= 2) {
              const pairs = [];
              for (let i = 0; i < layer.points.length - 1; i++) {
                pairs.push({ source: layer.points[i], target: layer.points[i + 1] });
              }
              layers.push(new deck.ArcLayer({
                id: 'arc-' + layer.id,
                data: pairs,
                getSourcePosition: d => [d.source.lng, d.source.lat],
                getTargetPosition: d => [d.target.lng, d.target.lat],
                getSourceColor: [...colorArr.slice(0,3), 200],
                getTargetColor: [255, 255, 255, 200],
                getWidth: 2,
                pickable: true,
              }));
            }
            break;

          case 'icon':
            layers.push(new deck.ScatterplotLayer({
              id: 'icon-' + layer.id,
              data: layer.points,
              getPosition: d => [d.lng, d.lat],
              getFillColor: [...colorArr.slice(0,3), 220],
              getRadius: 30,
              radiusMinPixels: 6,
              radiusMaxPixels: 16,
              stroked: true,
              getLineColor: [255, 255, 255, 160],
              lineWidthMinPixels: 2,
              pickable: true,
            }));
            break;

          default:
            break;
        }
      });
    });

    // Remove old overlay and create new
    if (deckOverlay) {
      deckOverlay.finalize();
    }

    deckOverlay = new deck.MapboxOverlay({
      layers,
      getTooltip: ({ object, layer }) => {
        if (!object) return null;
        if (layer && layer.id && layer.id.startsWith('pois-')) {
          return { html: '<b>' + esc(object.name) + '</b><br>' + esc(object.category), className: 'deck-tooltip' };
        }
        if (layer && layer.id && layer.id.startsWith('boundary-')) {
          return null; // boundary click handled separately
        }
        if (object.label) {
          return { html: esc(object.label) + (object.value != null ? '<br>Valor: ' + object.value : ''), className: 'deck-tooltip' };
        }
        return null;
      },
    });
    mapInstance.addControl(deckOverlay);
  }

  // ── Sidebar toggle ──
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });

  // ── Helpers ──
  function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function hexToRgb(hex) {
    const r = parseInt((hex || '#00e5cc').slice(1, 3), 16);
    const g = parseInt((hex || '#00e5cc').slice(3, 5), 16);
    const b = parseInt((hex || '#00e5cc').slice(5, 7), 16);
    return [r, g, b, 255];
  }

  // ── Auto-refresh every 5s ──
  setInterval(loadData, 5000);
})();
</script>
</body>
</html>`;
}
