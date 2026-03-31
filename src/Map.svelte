<script>
  import { onMount } from "svelte";
  import L from "leaflet";
  import protobuf from "protobufjs";

  let map;
  const markers = [];
  let locationMarker = null;

  let isFetching = false;
  let FeedMessage;

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

  function makeBusIcon(bearing, baseUrl) {
    const rotation = bearing - 0 || 0; // change this to -90 when movement works
    return L.divIcon({
      className: "",
      html: `
        <div class="bus-marker-wrap">
          <img
            src="${baseUrl}bus.png"
            class="bus-img"
            style="transform: rotate(${rotation}deg);"
          />
        </div>
      `,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      popupAnchor: [0, -20],
    });
  }

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
          console.log("bearing:", v.position.bearing);

          const routeId = v.trip?.routeId || "";

          let routeName = routeNames[routeId];
          if (!routeName) {
            routeName = Object.values(routeNames).find((name) =>
              routeId.includes(name)
            );
          }
          routeName = routeName || "N/A";

          return {
            routeName,
            lat: v.position.latitude,
            lng: v.position.longitude,
            bearing: v.position.bearing || 0,
          };
        });
    } catch (err) {
      console.error("Fetch buses failed:", err);
      return [];
    }
  }

  async function refreshBuses(routeNames, baseUrl) {
    if (isFetching) return;
    isFetching = true;

    try {
      markers.forEach((m) => m.remove());
      markers.length = 0;

      const buses = await fetchBuses(routeNames);

      buses.forEach((bus) => {
        const icon = makeBusIcon(bus.bearing, baseUrl);

        const marker = L.marker([bus.lat, bus.lng], { icon })
          .addTo(map)
          .bindTooltip(` ${bus.routeName}`, {
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

  function locateMe() {
    if (locationMarker) {
      map.setView(locationMarker.getLatLng(), 15);
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

    L.control.zoom({ position: "bottomright" }).addTo(map);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    const protoUrl = import.meta.env.BASE_URL + "gtfs-realtime.proto";
    const root = await protobuf.load(protoUrl);
    FeedMessage = root.lookupType("transit_realtime.FeedMessage");

    const baseUrl = import.meta.env.BASE_URL;

    const routeNames = await fetchRouteNames();
    await refreshBuses(routeNames, baseUrl);
    setInterval(() => refreshBuses(routeNames, baseUrl), 45000);

    if (navigator.geolocation) {
      navigator.geolocation.watchPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          if (locationMarker) {
            locationMarker.setLatLng([latitude, longitude]);
          } else {
            locationMarker = L.circleMarker([latitude, longitude], {
              radius: 10,
              fillColor: "#4285F4",
              color: "#fff",
              weight: 2,
              opacity: 1,
              fillOpacity: 1,
            })
              .addTo(map)
              .bindPopup("You are here");
            map.setView([latitude, longitude], 15);
          }
        },
        (err) => {
          console.warn("Geolocation error:", err);
        },
        { enableHighAccuracy: true }
      );
    }
  });
</script>

<div id="map"></div>

<button class="locate-btn" on:click={locateMe}>📍</button>

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

  :global(.leaflet-tooltip.bus-label) {
    background: #1a73e8 !important;
    color: white !important;
    border: none !important;
    border-radius: 4px;
    font-weight: bold;
    font-size: 11px;
    padding: 2px 5px;
  }

  :global(.bus-marker-wrap) {
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  :global(.bus-img) {
    width: 40px;
    height: 40px;
    object-fit: contain;
    transform-origin: center center;
  }

  .locate-btn {
    position: fixed;
    bottom: 100px;
    right: 16px;
    z-index: 1000;
    width: 44px;
    height: 44px;
    border-radius: 8px;
    border: none;
    background: white;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
    font-size: 22px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .locate-btn:active {
    background: #f0f0f0;
  }
</style>
