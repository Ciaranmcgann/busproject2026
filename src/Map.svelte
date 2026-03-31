<script>
  import { onMount } from "svelte";
  import L from "leaflet";
  import protobuf from "protobufjs";

  export let searchTerm = "";

  let map;
  let mapContainer;

  const markers = [];
  let locationMarker = null;

  let isFetching = false;
  let FeedMessage;
  let buses = [];

  function normalize(str) {
    return (str || "").replace(/\s/g, "").toLowerCase();
  }

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
      return lookup;
    } catch (e) {
      console.warn("Could not load route names", e);
      return {};
    }
  }

  function makeBusIcon(bearing, baseUrl) {
    const rotation = bearing || 0;
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

      if (!res.ok) return [];

      const buffer = await res.arrayBuffer();
      const feed = FeedMessage.decode(new Uint8Array(buffer));

      return feed.entity
        .map((e) => e.vehicle)
        .filter((v) => v && v.position)
        .map((v) => {
          const routeId = v.trip?.routeId || "";
          const routeName = routeNames[routeId] || "N/A";
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

  function applySearch() {
    const term = normalize(searchTerm);
    const visibleMarkers = [];

    markers.forEach((marker) => {
      const route = marker._busRoute;
      const matches = !searchTerm ? true : route.startsWith(term);

      if (matches) {
        marker.setOpacity(1);
        marker.getTooltip()?.getElement()?.style.setProperty("display", "");
        visibleMarkers.push(marker);
      } else {
        marker.setOpacity(0);
        marker.getTooltip()?.getElement()?.style.setProperty("display", "none");
      }
    });

    if (searchTerm && visibleMarkers.length > 0) {
      const group = L.featureGroup(visibleMarkers);
      map.fitBounds(group.getBounds().pad(0.1));
    }
  }

  async function refreshBuses(routeNames, baseUrl) {
    if (isFetching) return;
    isFetching = true;

    try {
      const newBuses = await fetchBuses(routeNames);

      if (markers.length === 0) {
        buses = newBuses;
        newBuses.forEach((bus) => {
          const icon = makeBusIcon(bus.bearing, baseUrl);
          const marker = L.marker([bus.lat, bus.lng], { icon })
            .addTo(map)
            .bindTooltip(` ${bus.routeName}`, {
              permanent: true,
              direction: "top",
              className: "bus-label",
            })
            .bindPopup(`Route ${bus.routeName}`);
          marker._busRoute = normalize(bus.routeName);
          markers.push(marker);
        });
        applySearch();
      } else {
        newBuses.forEach((newBus, i) => {
          const marker = markers[i];
          if (!marker) return;
          marker.setLatLng([newBus.lat, newBus.lng]);
          marker.setIcon(makeBusIcon(newBus.bearing, baseUrl));
        });
        buses = newBuses;
      }
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
    map = L.map(mapContainer).setView([53.35, -6.26], 12);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    const protoUrl = import.meta.env.BASE_URL + "gtfs-realtime.proto";
    const baseUrl = import.meta.env.BASE_URL;

    const [root, routeNames] = await Promise.all([
      protobuf.load(protoUrl),
      fetchRouteNames(),
    ]);

    FeedMessage = root.lookupType("transit_realtime.FeedMessage");

    refreshBuses(routeNames, baseUrl);
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
        (err) => console.warn("Geolocation error:", err),
        { enableHighAccuracy: true }
      );
    }
  });

  let searchDebounce;
  $: {
    searchTerm;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      if (map && markers.length) applySearch();
    }, 300);
  }
</script>

<div bind:this={mapContainer} class="map"></div>

{#if !buses.length}
  <div class="loading">Loading buses...</div>
{/if}

<button class="locate-btn" on:click={locateMe}>📍</button>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100%;
    overflow: hidden;
  }

  .map {
    width: 100%;
    height: 100%;
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

  :global(.leaflet-tooltip.bus-label) {
    background: #1a73e8 !important;
    color: white !important;
    border: none !important;
    border-radius: 4px;
    font-weight: bold;
    font-size: 11px;
    padding: 2px 5px;
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

  .loading {
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    background: white;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 13px;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
  }
</style>
