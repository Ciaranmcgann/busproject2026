// server.js
import express from 'express';
import fs from 'fs';
import path from 'path';
import https from 'https';
import unzipper from 'unzipper';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// --- Serve frontend ---
app.use(express.static(path.join(__dirname, 'public')));

// --- GTFS setup ---
const GTFS_FOLDER = path.join(__dirname, 'static_gtfs');
const GTFS_URL = 'https://example.com/gtfs.zip'; // <- replace with your hosted GTFS zip

async function ensureGTFS() {
  if (fs.existsSync(GTFS_FOLDER)) {
    console.log('GTFS folder exists, skipping download.');
    return;
  }

  console.log('Downloading GTFS files...');
  const zipPath = path.join(__dirname, 'gtfs.zip');
  const file = fs.createWriteStream(zipPath);

  await new Promise((resolve, reject) => {
    https.get(GTFS_URL, res => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });

  console.log('Extracting GTFS...');
  await fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: GTFS_FOLDER }))
    .promise();

  fs.unlinkSync(zipPath);
  console.log('GTFS ready.');
}

// --- Load GTFS data ---
let buses = [];
function loadGTFS() {
  // Example: reading routes.txt as JSON (customize for your API)
  const routesPath = path.join(GTFS_FOLDER, 'routes.txt');
  if (!fs.existsSync(routesPath)) return;

  const data = fs.readFileSync(routesPath, 'utf-8');
  // Simple CSV -> JSON parser
  const [header, ...lines] = data.trim().split('\n');
  const headers = header.split(',');

  buses = lines.map(line => {
    const values = line.split(',');
    const bus = {};
    headers.forEach((h, i) => { bus[h] = values[i]; });
    return bus;
  });

  console.log(`Loaded ${buses.length} routes from GTFS.`);
}

// --- API route ---
app.get('/api/buses', (req, res) => {
  res.json(buses); // send the routes or customize your output
});

// --- Start server ---
async function startServer() {
  await ensureGTFS();
  loadGTFS();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();