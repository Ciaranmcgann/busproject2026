<script>
  import { onMount } from "svelte";
  import L from "leaflet";
  import "leaflet.markercluster";
  import protobuf from "protobufjs";

  export let searchTerm = "";
  export let favourites = [];
  export let favouritesMode = false;

  let map;
  let mapContainer;

  let busData = new Map();
  let clusterGroup;
  let locationMarker = null;

  let isFetching = false;
  let FeedMessage;
  let buses = [];
  let selectedRoute = "";

  let allStops = [];
  let stopLayerGroup = null;

  let lastUpdated = null;
  let timeSinceUpdate = "";
  let timerInterval;

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

  function updateTimer() {
    if (!lastUpdated) return;
    const secs = Math.floor((Date.now() - lastUpdated) / 1000);
    if (secs < 60) {
      timeSinceUpdate = `Updated ${secs}s ago`;
    } else {
      const mins = Math.floor(secs / 60);
      timeSinceUpdate = `Updated ${mins}m ago`;
    }
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

  async function fetchStops() {
    try {
      const res = await fetch(
        "https://bus-times.ciaranjmcgann.workers.dev/static/stops.json"
      );
      const data = await res.json();
      allStops = data.filter(
        (s) =>
          s.stop_lat &&
          s.stop_lon &&
          isInDublin(parseFloat(s.stop_lat), parseFloat(s.stop_lon))
      );
    } catch (e) {
      console.warn("Could not load stops", e);
    }
  }

  function makeStopIcon() {
    return L.divIcon({
      className: "",
      html: `<div class="stop-marker"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
      popupAnchor: [0, -8],
    });
  }

  async function showStopPopup(marker, stop) {
    marker
      .bindPopup(
        `
      <div class="stop-popup">
        <div class="stop-popup-name">${stop.stop_name}</div>
        <div class="stop-popup-code">Stop ${stop.stop_code}</div>
        <div class="stop-popup-empty">Loading arrivals...</div>
      </div>
    `,
        { maxWidth: 260 }
      )
      .openPopup();

    try {
      const res = await fetch(
        `https://bus-times.ciaranjmcgann.workers.dev/stop-times/${stop.stop_id}`
      );
      const times = await res.json();

      const now = new Date();
      const nowMins = now.getHours() * 60 + now.getMinutes();

      const upcoming = times
        .filter((t) => {
          const [h, m] = t.arrival_time.split(":").map(Number);
          return h * 60 + m >= nowMins;
        })
        .slice(0, 8);

      if (upcoming.length === 0) {
        marker.setPopupContent(`
          <div class="stop-popup">
            <div class="stop-popup-name">${stop.stop_name}</div>
            <div class="stop-popup-code">Stop ${stop.stop_code}</div>
            <div class="stop-popup-empty">No upcoming arrivals</div>
          </div>
        `);
        return;
      }

      const rows = upcoming
        .map((t) => {
          const [h, m] = t.arrival_time.split(":");
          return `
          <div class="stop-popup-row">
            <span class="stop-popup-time">${h}:${m}</span>
            <span class="stop-popup-trip">${t.trip_id}</span>
          </div>
        `;
        })
        .join("");

      marker.setPopupContent(`
        <div class="stop-popup">
          <div class="stop-popup-name">${stop.stop_name}</div>
          <div class="stop-popup-code">Stop ${stop.stop_code}</div>
          ${rows}
        </div>
      `);
    } catch (err) {
      marker.setPopupContent(`
        <div class="stop-popup">
          <div class="stop-popup-name">${stop.stop_name}</div>
          <div class="stop-popup-empty">Failed to load arrivals</div>
        </div>
      `);
    }
  }

  function showStopsForRoute(normalizedRoute) {
    if (stopLayerGroup) {
      stopLayerGroup.clearLayers();
    } else {
      stopLayerGroup = L.layerGroup().addTo(map);
    }

    if (!normalizedRoute) return;

    const bounds = map.getBounds().pad(0.1);

    allStops.forEach((stop) => {
      const lat = parseFloat(stop.stop_lat);
      const lng = parseFloat(stop.stop_lon);
      if (!bounds.contains([lat, lng])) return;

      const marker = L.marker([lat, lng], { icon: makeStopIcon() });
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        showStopPopup(marker, stop);
      });

      stopLayerGroup.addLayer(marker);
    });
  }

  function makeBusIcon(bearing) {
    const rotation = bearing || 0;
    return L.divIcon({
      className: "",
      html: `
        <div class="bus-marker-wrap">
          <img
            src="${import.meta.env.BASE_URL}bus.png"
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
        .map((e) => ({ id: e.id, vehicle: e.vehicle }))
        .filter(({ vehicle: v }) => v && v.position)
        .map(({ id, vehicle: v }) => {
          const routeId = v.trip?.routeId || "";
          const routeName = routeNames[routeId] || "N/A";
          return {
            id,
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

  function shouldShow(normalizedRoute) {
    const term = normalize(searchTerm);
    const selected = normalize(selectedRoute);
    const matchesSearch = !searchTerm || normalizedRoute.startsWith(term);
    const matchesSelected = !selectedRoute || normalizedRoute === selected;
    const matchesFavourites =
      !favouritesMode || favourites.includes(normalizedRoute);
    return matchesSearch && matchesSelected && matchesFavourites;
  }

  function isNearViewport(lat, lng) {
    const bounds = map.getBounds().pad(0.3);
    return bounds.contains([lat, lng]);
  }

  function applySearch() {
    if (!map || !clusterGroup) return;

    const visibleMarkers = [];
    clusterGroup.clearLayers();

    busData.forEach((bus) => {
      const visible = shouldShow(bus.normalizedRoute);
      const inViewport = isNearViewport(bus.lat, bus.lng);

      if (visible && inViewport) {
        clusterGroup.addLayer(bus.marker);
        visibleMarkers.push(bus.marker);
      }

      const el = bus.marker.getElement?.();
      if (el) {
        if (selectedRoute && bus.normalizedRoute === normalize(selectedRoute)) {
          el.classList.add("selected-bus");
        } else {
          el.classList.remove("selected-bus");
        }
      }
    });

    showStopsForRoute(normalize(selectedRoute));

    if (searchTerm && visibleMarkers.length > 0) {
      const group = L.featureGroup(visibleMarkers);
      map.fitBounds(group.getBounds().pad(0.05));
    }
  }

  function createMarker(bus, normalizedRoute) {
    return L.marker([bus.lat, bus.lng], { icon: makeBusIcon(bus.bearing) })
      .bindTooltip(bus.routeName, {
        permanent: true,
        direction: "top",
        className: "bus-label",
      })
      .on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        selectedRoute = normalizedRoute;
        applySearch();
      });
  }

  async function refreshBuses(routeNames, isBackground = false) {
    if (isFetching) return;
    isFetching = true;

    try {
      const newBuses = await fetchBuses(routeNames);
      const incomingIds = new Set(newBuses.map((b) => b.id));

      if (!isBackground) {
        // Full reload — clear cluster completely first
        clusterGroup.clearLayers();
      }

      // Remove buses no longer in the feed
      busData.forEach((entry, id) => {
        if (!incomingIds.has(id)) {
          clusterGroup.removeLayer(entry.marker);
          busData.delete(id);
        }
      });

      // Update existing or add new
      newBuses.forEach((newBus) => {
        const normalizedRoute = normalize(newBus.routeName);

        if (busData.has(newBus.id)) {
          const entry = busData.get(newBus.id);
          entry.lat = newBus.lat;
          entry.lng = newBus.lng;
          entry.bearing = newBus.bearing;
          entry.normalizedRoute = normalizedRoute;
          entry.marker.setLatLng([newBus.lat, newBus.lng]);
          const img = entry.marker.getElement?.()?.querySelector("img");
          if (img) img.style.transform = `rotate(${newBus.bearing || 0}deg)`;
        } else {
          // New bus — create marker but don't add to cluster yet
          const marker = createMarker(newBus, normalizedRoute);
          busData.set(newBus.id, { ...newBus, normalizedRoute, marker });
        }
      });

      buses = newBuses;
      lastUpdated = Date.now();
      updateTimer();
      applySearch();
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

  function refreshPage() {
    window.location.reload();
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
      zoomSnap: 0.5,
      zoomDelta: 1,
      tap: false,
      maxZoom: 19,
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
    setTimeout(() => map.invalidateSize(), 0);

    timerInterval = setInterval(updateTimer, 1000);

    clusterGroup = L.markerClusterGroup({
      disableClusteringAtZoom: 14,
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: false,
      showCoverageOnHover: false,
      iconCreateFunction(cluster) {
        const count = cluster.getChildCount();
        return L.divIcon({
          html: `<div class="cluster-icon">${count}</div>`,
          className: "",
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        });
      },
    });

    map.addLayer(clusterGroup);

    map.on("moveend zoomend", () => applySearch());
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

    const [root, routeNames] = await Promise.all([
      protobuf.load(protoUrl),
      fetchRouteNames(),
      fetchStops(),
    ]);

    FeedMessage = root.lookupType("transit_realtime.FeedMessage");

    // First load — full refresh
    refreshBuses(routeNames, false);

    // Background — silent position updates only
    setInterval(() => refreshBuses(routeNames, true), 45000);

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
    favourites;
    favouritesMode;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      if (map && busData.size) applySearch();
    }, 300);
  }
</script>

<div bind:this={mapContainer} class="map"></div>

{#if !buses.length}
  <div class="loading">
    <img
      src="{import.meta.env.BASE_URL}bus.png"
      class="spinner"
      alt="loading"
    />
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

<button class="refresh-btn" on:click={refreshPage}>
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
  >
    <polyline points="23 4 23 10 17 10"></polyline>
    <polyline points="1 20 1 14 7 14"></polyline>
    <path
      d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"
    ></path>
  </svg>
</button>

{#if timeSinceUpdate}
  <div class="update-pill">{timeSinceUpdate}</div>
{/if}

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
    z-index: 1000 !important;
    filter: drop-shadow(0 0 6px rgba(26, 115, 232, 0.9));
  }

  :global(.cluster-icon) {
    width: 36px;
    height: 36px;
    background: #1a73e8;
    color: white;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    border: 2px solid white;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  }

  :global(.stop-marker) {
    width: 12px;
    height: 12px;
    background: white;
    border: 2px solid #1a73e8;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }

  :global(.stop-popup) {
    font-family: system-ui, sans-serif;
    min-width: 180px;
  }

  :global(.stop-popup-name) {
    font-weight: 700;
    font-size: 14px;
    margin-bottom: 2px;
  }

  :global(.stop-popup-code) {
    font-size: 11px;
    color: #888;
    margin-bottom: 8px;
  }

  :global(.stop-popup-row) {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
    border-top: 1px solid #f0f0f0;
    font-size: 13px;
  }

  :global(.stop-popup-time) {
    font-weight: 700;
    color: #1a73e8;
    min-width: 42px;
  }

  :global(.stop-popup-trip) {
    color: #555;
    font-size: 12px;
  }

  :global(.stop-popup-empty) {
    font-size: 13px;
    color: #999;
    padding: 4px 0;
  }

  .locate-btn,
  .refresh-btn {
    position: fixed;
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

  .locate-btn {
    top: 70px;
  }

  .refresh-btn {
    top: 130px;
  }

  .locate-btn svg,
  .refresh-btn svg {
    display: block;
  }

  .update-pill {
    position: fixed;
    bottom: 66px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    font-size: 12px;
    padding: 4px 12px;
    border-radius: 20px;
    pointer-events: none;
    white-space: nowrap;
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
