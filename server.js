// server.js
import express from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Serve frontend
app.use(express.static(path.join(process.cwd(), 'public')));

// Load routes.txt into memory
const GTFS_FOLDER = path.join(process.cwd(), 'static_gtfs');
let buses = [];

function loadRoutes() {
  const routesPath = path.join(GTFS_FOLDER, 'routes.txt');
  if (!fs.existsSync(routesPath)) {
    console.error('routes.txt not found in static_gtfs/');
    return;
  }

  const data = fs.readFileSync(routesPath, 'utf-8');
  const [header, ...lines] = data.trim().split('\n');
  const headers = header.split(',');

  buses = lines.map(line => {
    const values = line.split(',');
    const bus = {};
    headers.forEach((h, i) => { bus[h] = values[i]; });
    return bus;
  });

  console.log(`Loaded ${buses.length} routes from routes.txt`);
}

// API endpoint to return buses
app.get('/api/buses', (req, res) => {
  res.json(buses);
});

// Initial load
loadRoutes();

// Optional: reload routes.txt every 30s in case it changes
setInterval(loadRoutes, 30000);

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});