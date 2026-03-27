<script>
  import { onMount } from "svelte";
  import L from "leaflet";
  import protobuf from "protobufjs";

  let map;
  const markers = [];

  // ✅ prevents overlapping API calls (helps avoid 429 errors)
  let isFetching = false;

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
        const routeName = routeNames[routeId] || routeId || "N/A";

        return {
          routeName,
          lat: v.position.latitude,
          lng: v.position.longitude,
        };
      });
  }

  async function refreshBuses(routeNames, busIcon) {
    if (isFetching) return;
    isFetching = true;

    try {
      markers.forEach((m) => m.remove());
      markers.length = 0;

      const buses = await fetchBuses(routeNames);

      buses.forEach((bus) => {
        const marker = L.marker([bus.lat, bus.lng], { icon: busIcon })
          .addTo(map)
          .bindTooltip(bus.routeName, {
            permanent: true,
            direction: "top",
            offset: [0, -10],
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

  onMount(async () => {
    map = L.map("map", {
      zoomControl: false,
      dragging: true,
      touchZoom: true,
      doubleClickZoom: true,
      scrollWheelZoom: false,
    }).setView([53.35, -6.26], 12);

    L.control
      .zoom({
        position: "bottomright",
      })
      .addTo(map);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    // ✅ aoife.png from public folder
    const busIcon = L.icon({
      iconUrl: import.meta.env.BASE_URL + "aoife.png",
      iconSize: [32, 32],
      iconAnchor: [16, 32],
      popupAnchor: [0, -32],
    });

    const routeNames = await fetchRouteNames();

    await refreshBuses(routeNames, busIcon);

    // ✅ slower refresh to avoid 429 errors
    setInterval(() => refreshBuses(routeNames, busIcon), 30000);
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

  /* Bigger zoom buttons for mobile */
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

  /* Route label styling (smaller + above icon) */
  :global(.bus-label) {
    background: rgba(26, 115, 232, 0.9);
    color: white;
    border: none;
    border-radius: 4px;
    font-weight: bold;
    font-size: 10px;
    padding: 1px 4px;
    white-space: nowrap;
    text-align: center;
  }
</style>
