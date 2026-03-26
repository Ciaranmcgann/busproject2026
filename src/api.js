// src/api.js
export async function getVehicles() {
  const res = await fetch("https://bus-times.ciaranjmcgann.workers.dev/vehicles");
  return res.json(); // Now returns [{route, lat, lng}, ...]
}