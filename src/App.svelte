<script>
  import { onMount } from "svelte";
  import L from "leaflet";

  const WORKER_URL = "https://YOUR-WORKER-URL"; // <-- change this

  let map;
  let markersLayer;

  let routeMap = {};

  async function loadData() {
    try {
      // Fetch routes
      const routesRes = await fetch(`${WORKER_URL}/routes`);
      const routes = await routesRes.json();

      // Build lookup map
      routeMap = {};
      routes.forEach((r) => {
        routeMap[r.route_id] = r;
      });

      // Fetch vehicles (already JSON now)
      const vehiclesRes = await fetch(`${WORKER_URL}/vehicles`);
      const vehicles = await vehiclesRes.json();

      // Clear old markers
      markersLayer.clearLayers();

      vehicles.forEach((v) => {
        if (!v.lat || !v.lng) return;

        const routeInfo = routeMap[String(v.routeId)];

        const routeName = routeInfo
          ? `${routeInfo.route_short_name} - ${routeInfo.route_long_name}`
          : `Route ${v.routeId}`;

        const marker = L.marker([v.lat, v.lng]).bindPopup(
          `<b>${routeName}</b>`
        );

        markersLayer.addLayer(marker);
      });
    } catch (err) {
      console.error("Error loading data:", err);
    }
  }

  onMount(async () => {
    map = L.map("map").setView([53.35, -6.26], 12);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
    }).addTo(map);

    markersLayer = L.layerGroup().addTo(map);

    await loadData();

    // Refresh every 15 seconds
    setInterval(loadData, 15000);
  });
</script>

<div id="map"></div>

<style>
  #map {
    height: 100vh;
    width: 100%;
  }
</style>
