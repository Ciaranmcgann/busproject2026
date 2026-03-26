import express from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// Load routes and stops
const GTFS_FOLDER = path.join(__dirname, 'static_gtfs');
let buses = [];

function parseCSVLine(line, expectedColumns) {
  const parts = line.split(',');
  if (parts.length < expectedColumns) {
    console.warn('Skipping malformed line:', line);
    return null;
  }
  return parts.map(p => p.trim());
}

function loadBuses() {
  let routes = [];
  let stops = [];

  const routesPath = path.join(GTFS_FOLDER, 'routes.txt');
  const stopsPath = path.join(GTFS_FOLDER, 'stops.txt');

  // Load routes
  if (fs.existsSync(routesPath)) {
    routes = fs.readFileSync(routesPath, 'utf-8')
      .trim()
      .split('\n')
      .slice(1)
      .map(l => {
        const parsed = parseCSVLine(l, 2);
        if (!parsed) return null;
        const [route_id, route_short_name] = parsed;
        return { route_id, route_short_name };
      })
      .filter(r => r);
  } else {
    console.warn('routes.txt not found! Using fallback routes.');
    routes = [
      { route_id: '1', route_short_name: '10' },
      { route_id: '2', route_short_name: '20' },
      { route_id: '3', route_short_name: '30' },
    ];
  }

  // Load stops
  if (fs.existsSync(stopsPath)) {
    stops = fs.readFileSync(stopsPath, 'utf-8')
      .trim()
      .split('\n')
      .slice(1)
      .map(l => {
        const parsed = parseCSVLine(l, 4);
        if (!parsed) return null;
        const [stop_id, stop_name, stop_lat, stop_lon] = parsed;
        const lat = parseFloat(stop_lat);
        const lng = parseFloat(stop_lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { stop_id, stop_name, lat, lng };
      })
      .filter(s => s);
  } else {
    console.warn('stops.txt not found! Using fallback stops.');
    stops = [
      { stop_id: '1', stop_name: 'Main St', lat: 53.3498, lng: -6.2603 },
      { stop_id: '2', stop_name: 'High St', lat: 53.347, lng: -6.262 },
      { stop_id: '3', stop_name: 'Station Rd', lat: 53.350, lng: -6.265 },
    ];
  }

  if (stops.length === 0) {
    console.error('No valid stops found. Buses will not load.');
    buses = [];
    return;
  }

  buses = routes.map((r, i) => {
    const stop = stops[i % stops.length]; // simple round-robin
    return {
      id: r.route_id,
      route: r.route_short_name || r.route_id,
      lat: stop.lat,
      lng: stop.lng
    };
  });

  console.log(`Loaded ${routes.length} routes and ${stops.length} stops`);
}

// API endpoint
app.get('/api/buses', (req, res) => {
  res.json(buses);
});

// Initial load + refresh every 30s
loadBuses();
setInterval(loadBuses, 30000);

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));