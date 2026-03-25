// public/app.js

// Initialize map
const map = L.map('map').setView([53.3498, -6.2603], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19
}).addTo(map);

// Marker storage
let markers = [];

// Custom bus icon
const busIcon = L.icon({
  iconUrl: 'icons/bus.png',
  iconSize: [40, 40],
  iconAnchor: [20, 20],
});

// Add markers to map
function addMarkers(buses) {
  markers.forEach(m => map.removeLayer(m));
  markers = [];

  buses.forEach(bus => {
    if (!bus.route_id) return; // skip invalid

    const lat = 53.3498 + Math.random() * 0.01; // mock lat
    const lng = -6.2603 + Math.random() * 0.01; // mock lng

    const marker = L.marker([lat, lng], { icon: busIcon })
      .addTo(map)
      .bindPopup(`Route: ${bus.route_short_name || bus.route_id}`);

    markers.push(marker);
  });
}

// Fetch buses from server
async function fetchBuses() {
  try {
    const res = await fetch('/api/buses');
    const buses = await res.json();
    addMarkers(buses);
  } catch (err) {
    console.error('Error fetching buses:', err);
  }
}

// Initial fetch + interval
fetchBuses();
setInterval(fetchBuses, 15000);