<script>
  import { onMount } from "svelte";
  import L from "leaflet";
  import protobuf from "protobufjs";

  let map;
  const markers = [];

  // Build a routeId -> shortName lookup from static GTFS routes.txt
  async function fetchRouteNames() {
    try {
      const res = await fetch(
        "https://bus-times.ciaranjmcgann.workers.dev/routes"
      );
      const text = await res.text();
      const lines = text.trim().split("\n");
      const headers = lines[0].split(",");
      const idIdx = headers.indexOf("route_id");
      const nameIdx = headers.indexOf("route_short_name");
      const lookup = {};
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        if (cols[idIdx] && cols[nameIdx]) {
          lookup[cols[idIdx].trim()] = cols[nameIdx].trim();
        }
      }
      return lookup;
    } catch (e) {
      console.warn("Could not load route names", e);
      return {};
    }
  }

  async function fetchBuses(routeNames) {
    // FIX 1: use import.meta.env.BASE_URL so path works on GitHub Pages
    const protoUrl = import.meta.env.BASE_URL + "gtfs-realtime.proto";
    const root = await protobuf.load(protoUrl);
    const FeedMessage = root.lookupType("transit_realtime.FeedMessage");

    const res = await fetch(
      "https://bus-times.ciaranjmcgann.workers.dev/vehicles"
    );
    const buffer = await res.arrayBuffer();
    const feed = FeedMessage.decode(new Uint8Array(buffer));

    return feed.entity
      .map((e) => e.vehicle)
      .filter((v) => v && v.position)
      .map((v) => {
        const routeId = v.trip?.routeId || "";
        // FIX 3: look up human-readable short name, fall back to routeId
        const routeName = routeNames[routeId] || routeId || "N/A";
        return {
          routeName,
          lat: v.position.latitude,
          lng: v.position.longitude,
        };
      });
  }

  async function refreshBuses(routeNames, busIcon) {
    // Clear old markers
    markers.forEach((m) => m.remove());
    markers.length = 0;

    const buses = await fetchBuses(routeNames);
    buses.forEach((bus) => {
      const marker = L.marker([bus.lat, bus.lng], { icon: busIcon })
        .addTo(map)
        // FIX 3: show route short name on the marker itself
        .bindTooltip(bus.routeName, {
          permanent: true,
          direction: "top",
          className: "bus-label",
        })
        .bindPopup(`Route ${bus.routeName}`);
      markers.push(marker);
    });
  }

  onMount(async () => {
    map = L.map("map").setView([53.35, -6.26], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(
      map
    );

    // FIX 1: use BASE_URL for icon path too
    const busIcon = L.icon({
      iconUrl: import.meta.env.BASE_URL + "bus.png",
      iconSize: [32, 32],
      iconAnchor: [16, 32],
      popupAnchor: [0, -32],
    });

    const routeNames = await fetchRouteNames();

    await refreshBuses(routeNames, busIcon);

    // FIX 2: refresh buses every 15 seconds
    setInterval(() => refreshBuses(routeNames, busIcon), 15000);
  });
</script>

<div id="map"></div>

<style>
  #map {
    height: 100%;
    width: 100%;
  }

  /* Style the route name labels on the map */
  :global(.bus-label) {
    background: #1a73e8;
    color: white;
    border: none;
    border-radius: 4px;
    font-weight: bold;
    font-size: 11px;
    padding: 2px 5px;
    white-space: nowrap;
  }
</style>
