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

  let selectedRoute = "";

  const DUBLIN_BOUNDS = {
    minLat: 53.14,
    maxLat: 53.46,
    minLng: -6.63,
    maxLng: -6.0,
  };

  function isInDublin(lat, lng) {
    return (
      lat >= DUBLIN_BOUNDS.minLat &&
      lat <= DUBLIN_BOUNDS.maxLat &&
      lng >= DUBLIN_BOUNDS.minLng &&
      lng <= DUBLIN_BOUNDS.maxLng
    );
  }

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
        })
        .filter((bus) => isInDublin(bus.lat, bus.lng));
    } catch (err) {
      console.error("Fetch buses failed:", err);
      return [];
    }
  }

  function updateMarkerStyles() {
    const selected = normalize(selectedRoute);

    markers.forEach((marker) => {
      const route = marker._busRoute;
      const el = marker.getElement();

      if (!el) return;

      if (selectedRoute && route === selected) {
        el.classList.add("selected-bus");
      } else {
        el.classList.remove("selected-bus");
      }
    });
  }

  function applySearch() {
    const term = normalize(searchTerm);
    const selected = normalize(selectedRoute);

    const visibleMarkers = [];

    markers.forEach((marker) => {
      const route = marker._busRoute;

      const matchesSearch = !searchTerm || route.startsWith(term);
      const matchesSelected = !selectedRoute || route === selected;

      const isVisible = matchesSearch && matchesSelected;

      if (isVisible) {
        if (!map.hasLayer(marker)) marker.addTo(map);
        marker.setOpacity(1);
        visibleMarkers.push(marker);
      } else {
        if (map.hasLayer(marker)) map.removeLayer(marker);
      }
    });

    updateMarkerStyles();

    if ((searchTerm || selectedRoute) && visibleMarkers.length > 0) {
      const group = L.featureGroup(visibleMarkers);
      map.fitBounds(group.getBounds().pad(0.05));
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
            .bindTooltip(bus.routeName, {
              permanent: true,
              direction: "top",
              className: "bus-label",
            })
            .on("click", () => {
              selectedRoute = marker._busRoute;
              applySearch();
            });

          marker._busRoute = normalize(bus.routeName);
          markers.push(marker);
        });

        applySearch();
      } else {
        newBuses.forEach((newBus, i) => {
          const marker = markers[i];
          if (!marker) return;

          marker.setLatLng([newBus.lat, newBus.lng]);

          // Update rotation without recreating icon (performance fix)
          const img = marker.getElement()?.querySelector("img");
          if (img) {
            img.style.transform = `rotate(${newBus.bearing || 0}deg)`;
          }
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
    map = L.map(mapContainer, {
      zoomControl: true,
      scrollWheelZoom: true,
      dragging: true,
      touchZoom: true,
      doubleClickZoom: true,
      boxZoom: true,
      keyboard: true,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      maxBounds: [
        [53.14, -6.63],
        [53.46, -6.0],
      ],
      maxBoundsViscosity: 1.0,
    });

    map.fitBounds([
      [53.14, -6.63],
      [53.46, -6.0],
    ]);

    setTimeout(() => {
      map.invalidateSize();
    }, 0);

    map.on("click", () => {
      selectedRoute = "";
      applySearch();
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
      updateWhenIdle: false,
      updateWhenZooming: true,
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
  <div class="loading">
    <img src="{import.meta.env.BASE_URL}bus.png" class="spinner" />
    <span>Loading buses...</span>
  </div>
{/if}

<button class="locate-btn" on:click={locateMe}>
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
  >
    <circle cx="12" cy="12" r="8"></circle>
    <line x1="12" x2="12" y1="2" y2="6"></line>
    <line x1="12" x2="12" y1="18" y2="22"></line>
    <line x1="2" y1="12" x2="6" y2="12"></line>
    <line x1="18" y1="12" x2="22" y2="12"></line>
  </svg>
</button>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100%;
    overflow: hidden;
    touch-action: pan-x pan-y;
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

  :global(.selected-bus) {
    transform: scale(1.4);
    z-index: 1000;
    filter: drop-shadow(0 0 6px rgba(26, 115, 232, 0.9));
  }

  .locate-btn {
    position: fixed;
    top: 70px;
    right: 10px;
    z-index: 1000;

    width: 50px;
    height: 50px;

    border: none;
    border-radius: 4px;
    background: white;
    color: #333;

    box-shadow: 0 1px 5px rgba(0, 0, 0, 0.4);

    display: flex;
    align-items: center;
    justify-content: center;

    cursor: pointer;
    padding: 0;
  }

  .locate-btn svg {
    display: block;
  }

  .loading {
    position: fixed;
    inset: 0;
    z-index: 2000;

    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;

    background: rgba(255, 255, 255, 0.8);
    backdrop-filter: blur(4px);

    gap: 10px;
  }

  .spinner {
    width: 48px;
    height: 48px;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
