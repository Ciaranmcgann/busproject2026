// --- 1. Marker storage ---
let markers = {}; // keyed by bus.id

const busIcon = L.icon({
  iconUrl: 'icons/bus.png',
  iconSize: [40, 40],
  iconAnchor: [20, 20],
});

// --- 2. Add or update markers ---
function addOrUpdateMarkers(buses, map) {
  buses.forEach(bus => {
    if (!bus.lat || !bus.lng) return;

    if (!markers[bus.id]) {
      // create marker if it doesn't exist
      markers[bus.id] = L.marker([bus.lat, bus.lng], { icon: busIcon })
        .addTo(map)
        .bindPopup(`Route: ${bus.route}`);
    } else {
      // update position
      markers[bus.id].setLatLng([bus.lat, bus.lng])
                     .bindPopup(`Route: ${bus.route}`);
    }
  });

  // save to localStorage for fast reload
  localStorage.setItem('lastBuses', JSON.stringify(buses));
}

// --- 3. Fetch buses ---
async function fetchBuses() {
  try {
    const res = await fetch("/api/buses");
    const buses = await res.json();
    if (buses.length) addOrUpdateMarkers(buses, map);
    return buses;
  } catch (err) {
    console.error("Error fetching buses:", err);
    return [];
  }
}

// --- 4. Immediate fetch ---
const initialBusesPromise = fetchBuses();

// --- 5. Initialize map ---
const map = L.map('map').setView([53.3498, -6.2603], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19
}).addTo(map);

// --- 6. When map is ready ---
map.whenReady(() => {
  // load buses from localStorage instantly
  const savedBuses = JSON.parse(localStorage.getItem('lastBuses') || '[]');
  if (savedBuses.length) addOrUpdateMarkers(savedBuses, map);

  // apply first API fetch
  initialBusesPromise.then(buses => {
    if (buses.length) addOrUpdateMarkers(buses, map);
  });

  // regular updates every 15 seconds
  setInterval(fetchBuses, 8000);
});