<script>
  import { onMount } from "svelte";
  import L from "leaflet";
  import protobuf from "protobufjs";

  let map;
  const markers = [];

  let isFetching = false;
  let FeedMessage;

  // ===== FETCH ROUTE NAMES =====
  async function fetchRouteNames() {
    try {
      const res = await fetch(
        "https://bus-times.ciaranjmcgann.workers.dev/routes"
      );
      const routes = await res.json();
      const lookup = {};

      for (const r of routes) {
        if (r.route_id && r.route_short_name) {
          lookup[r.route_id.trim()] = r.route_short_name.trim();
        }
      }

      console.log("Loaded routes:", Object.keys(lookup).length);
      return lookup;
    } catch (e) {
      console.warn("Could not load route names", e);
      return {};
    }
  }

  // ===== FETCH BUSES =====
  async function fetchBuses(routeNames) {
    try {
      const res = await fetch(
        "https://bus-times.ciaranjmcgann.workers.dev/vehicles"
      );

      if (!res.ok) {
        console.warn("API error:", res.status);
        if (res.status === 429) {
          console.warn("Rate limited — skipping refresh");
        }
        return [];
      }

      const buffer = await res.arrayBuffer();
      const feed = FeedMessage.decode(new Uint8Array(buffer));

      return feed.entity
        .map((e) => e.vehicle)
        .filter((v) => v && v.position)
        .map((v) => {
          const routeId = v.trip?.routeId || "";

          // 🔥 BULLETPROOF MATCHING
          let routeName = routeNames[routeId];

          if (!routeName) {
            routeName = Object.values(routeNames).find((name) =>
              routeId.includes(name)
            );
          }

          routeName = routeName || "N/A";

          // Debug (optional)
          console.log("MATCH:", routeId, "→", routeName);

          return {
            routeName,
            lat: v.position.latitude,
            lng: v.position.longitude,
          };
        });
    } catch (err) {
      console.error("Fetch buses failed:", err);
      return [];
    }
  }

  // ===== REFRESH MARKERS =====
  async function refreshBuses(routeNames, busIcon) {
    if (isFetching) return;
    isFetching = true;

    try {
      // Remove old markers
      markers.forEach((m) => m.remove());
      markers.length = 0;

      const buses = await fetchBuses(routeNames);

      buses.forEach((bus) => {
        const marker = L.marker([bus.lat, bus.lng], { icon: busIcon })
          .addTo(map)
          .bindTooltip(`🚌 ${bus.routeName}`, {
            permanent: true,
            direction: "top",
            className: "bus-label",
          })
          .bindPopup(`Route ${bus.routeName}`);

        markers.push(marker);
      });
    } catch (err) {
      console.error("Failed to refresh buses:", err);
    } finally {
      isFetching = false;
    }
  }

  // ===== INIT =====
  onMount(async () => {
    map = L.map("map", {
      zoomControl: false,
      dragging: true,
      touchZoom: true,
      doubleClickZoom: true,
      scrollWheelZoom: false,
    }).setView([53.35, -6.26], 12);

    L.control.zoom({ position: "bottomright" }).addTo(map);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    // Load protobuf
    const protoUrl = import.meta.env.BASE_URL + "gtfs-realtime.proto";
    const root = await protobuf.load(protoUrl);
    FeedMessage = root.lookupType("transit_realtime.FeedMessage");

    // Bus icon
    const busIcon = L.icon({
      iconUrl: import.meta.env.BASE_URL + "aoife.png",
      iconSize: [40, 40],
      iconAnchor: [16, 32],
      popupAnchor: [0, -32],
    });

    const routeNames = await fetchRouteNames();

    await refreshBuses(routeNames, busIcon);

    setInterval(() => refreshBuses(routeNames, busIcon), 45000);
  });
</script>

<div id="map"></div>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100%;
    overflow: hidden;
  }

  #map {
    height: 100vh;
    width: 100vw;
    touch-action: pan-x pan-y;
  }

  :global(.leaflet-control-zoom a) {
    width: 44px;
    height: 44px;
    line-height: 44px;
    font-size: 20px;
  }

  :global(.leaflet-control-zoom) {
    margin-bottom: 20px;
    margin-right: 10px;
  }

  :global(.bus-label) {
    background: #1a73e8;
    color: white;
    border: none;
    border-radius: 4px;
    font-weight: bold;
    font-size: 11px;
    padding: 2px 5px;
    white-space: nowrap;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
</style>
