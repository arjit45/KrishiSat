import React from 'react';
import { MapPin } from 'lucide-react';
import { MapContainer, TileLayer, Circle, CircleMarker, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { severityOf } from '../constants/severity';
import { fmtPct } from '../lib/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// MapView — F8, the SUPPLEMENTARY selector (§10.2 F6/F8): the grid owns
// selection state at app level, and a marker click selects the same district, so
// the two can never disagree.
//
// Coordinates are not duplicated here: they arrive from the API's own district
// payloads (the single registry, §11.1/§20.1), so this file can never drift
// from the registry the backend computes with. A district whose coordinates have
// not been fetched yet is simply not drawn, rather than guessed.
//
// OSM tile policy (§13.4): attribution is rendered in the corner of the map.
// The 50 km ring is the monitoring radius F8 specifies.
// ─────────────────────────────────────────────────────────────────────────────

const INDIA_CENTER = [22.8, 79.5];
const INITIAL_ZOOM = 5;

export default function MapView({ districts, coords, active, onSelect }) {
  const rows = (districts || []).filter((d) => coords[d.id]);

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5" aria-label="District map">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <MapPin className="w-4 h-4 text-emerald-400" /> District map — 50 km monitoring radius
        </h2>
        <span className="text-[9px] text-slate-600">supplementary selector · grid is primary (F6)</span>
      </div>

      <div className="rounded-xl overflow-hidden border border-slate-800" style={{ height: '320px' }}>
        <MapContainer center={INDIA_CENTER} zoom={INITIAL_ZOOM} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false}>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          />
          {rows.map((d) => {
            const { lat, lon } = coords[d.id];
            const sev = severityOf(d.severity);
            const isActive = active === d.id;
            return (
              <React.Fragment key={d.id}>
                <Circle
                  center={[lat, lon]}
                  radius={50_000}
                  pathOptions={{
                    color: sev.dot,
                    weight: isActive ? 2 : 1,
                    fillColor: sev.dot,
                    fillOpacity: isActive ? 0.12 : 0.06,
                    dashArray: '4 4',
                  }}
                />
                <CircleMarker
                  center={[lat, lon]}
                  radius={isActive ? 9 : 7}
                  pathOptions={{ color: '#020617', weight: 2, fillColor: sev.dot, fillOpacity: 1 }}
                  eventHandlers={{ click: () => onSelect(d.id) }}
                >
                  <Popup>
                    <div style={{ minWidth: '160px', fontFamily: 'inherit' }}>
                      <p style={{ margin: 0, fontWeight: 800, fontSize: '13px' }}>{d.name}, {d.state}</p>
                      <p style={{ margin: '2px 0', fontSize: '11px', color: '#475569' }}>{d.zone}</p>
                      <p style={{ margin: '6px 0 0', fontSize: '12px' }}>
                        WSI <strong>{fmtPct(d.wsi)}</strong> · {sev.label}
                      </p>
                      <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#475569' }}>{d.cropStage}</p>
                      <button
                        type="button"
                        onClick={() => onSelect(d.id)}
                        style={{
                          marginTop: '8px', padding: '4px 10px', borderRadius: '8px', border: 'none',
                          background: '#10b981', color: '#020617', fontWeight: 700, fontSize: '11px', cursor: 'pointer',
                        }}
                      >
                        {isActive ? 'Selected' : 'Select district'}
                      </button>
                    </div>
                  </Popup>
                </CircleMarker>
              </React.Fragment>
            );
          })}
        </MapContainer>
      </div>

      {rows.length < (districts || []).length ? (
        <p className="text-[10px] text-slate-600 mt-2">
          {rows.length} of {(districts || []).length} districts plotted — coordinates appear as each district's
          payload is read (one registry, no duplicated coordinates in the frontend).
        </p>
      ) : null}
    </section>
  );
}
