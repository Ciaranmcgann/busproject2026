<script>
  import { onMount } from "svelte";
  import L from "leaflet";
  import "leaflet.markercluster";
  import protobuf from "protobufjs";

  export let searchTerm = "";
  export let favourites = [];
  export let favouritesMode = false;
  export let showStops = false;

  let map;
  let mapContainer;

  let busData = new Map();
  let clusterGroup;
  let locationMarker = null;

  let shapeLayerGroup = null;
  let isFetching = false;
  let FeedMessage;
  let buses = [];
  let selectedRoute = "";

  let allStops = [];
  let stopLayerGroup = null;
  let allStopsLayerGroup = null;

  let lastUpdated = null;
  let timeSinceUpdate = "";
  let timerInterval;
  let routeStopIds = new Map();

  let shapePoints = new Map();
  let tripShapeMap = new Map();
  let tripStopSequence = new Map();
  let stopLatLng = new Map();
  let shouldAutoFit = false;
  let selectedTripId = "";

  const API = "https://bus-times.ciaranjmcgann.workers.dev";

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

  function calculateBearing(lat1, lng1, lat2, lng2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const dLng = toRad(lng2 - lng1);
    const y = Math.sin(dLng) * Math.cos(toRad(lat2));
    const x =
      Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function getTripDirection(tripId) {
    const stops = tripStopSequence.get(tripId);
    if (!stops || stops.length < 2) return "unknown";
    const first = stopLatLng.get(stops[0].stop_id);
    const last = stopLatLng.get(stops[stops.length - 1].stop_id);
    if (!first || !last) return "unknown";
    return last.lat > first.lat ? "northbound" : "southbound";
  }

  function getBearingFromStops(tripId, busLat, busLng) {
    const stops = tripStopSequence.get(tripId);
    if (!stops || stops.length < 2) return null;

    let nearestIdx = 0;
    let nearestDist = Infinity;

    for (let i = 0; i < stops.length; i++) {
      const s = stopLatLng.get(stops[i].stop_id);
      if (!s) continue;
      const dLat = s.lat - busLat;
      const dLng = s.lng - busLng;
      const dist = dLat * dLat + dLng * dLng;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }

    const nextIdx = Math.min(nearestIdx + 1, stops.length - 1);
    const from = stopLatLng.get(stops[nearestIdx].stop_id);
    const to = stopLatLng.get(stops[nextIdx].stop_id);

    if (!from || !to) return null;
    if (from.lat === to.lat && from.lng === to.lng) return null;

    return calculateBearing(from.lat, from.lng, to.lat, to.lng);
  }

  function getBearingFromShape(shapeId, busLat, busLng) {
    const points = shapePoints.get(shapeId);
    if (!points || points.length < 2) return null;

    let bestBearing = null;
    let bestDist = Infinity;

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const midLat = (a.lat + b.lat) / 2;
      const midLng = (a.lng + b.lng) / 2;
      const dLat = midLat - busLat;
      const dLng = midLng - busLng;
      const dist = dLat * dLat + dLng * dLng;

      if (dist < bestDist) {
        bestDist = dist;
        bestBearing = calculateBearing(a.lat, a.lng, b.lat, b.lng);
      }
    }

    return bestBearing;
  }

  function resolveBearing(newBus) {
    const stopBearing = getBearingFromStops(
      newBus.tripId,
      newBus.lat,
      newBus.lng
    );
    if (stopBearing !== null) return stopBearing;

    const shapeId = tripShapeMap.get(newBus.tripId);
    if (shapeId) {
      const shapeBearing = getBearingFromShape(shapeId, newBus.lat, newBus.lng);
      if (shapeBearing !== null) return shapeBearing;
    }

    return 0;
  }

  async function fetchRouteNames() {
    try {
      const res = await fetch(`${API}/routes`);
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
      const res = await fetch(`${API}/static/stops.json`);
      const data = await res.json();
      const stopsArray = Array.isArray(data) ? data : Object.values(data);

      allStops = stopsArray.filter(
        (s) =>
          s.stop_lat &&
          s.stop_lon &&
          isInDublin(parseFloat(s.stop_lat), parseFloat(s.stop_lon))
      );

      for (const s of stopsArray) {
        if (s.stop_id && s.stop_lat && s.stop_lon) {
          stopLatLng.set(s.stop_id, {
            lat: parseFloat(s.stop_lat),
            lng: parseFloat(s.stop_lon),
          });
        }
      }
    } catch (e) {
      console.warn("Could not load stops", e);
    }
  }

  async function fetchShapes() {
    try {
      const shapesRes = await fetch(`${API}/static/shapes.txt`);
      const text = await shapesRes.text();
      const lines = text.trim().split("\n");
      const headers = lines[0].split(",").map((h) => h.trim());
      const idIdx = headers.indexOf("shape_id");
      const latIdx = headers.indexOf("shape_pt_lat");
      const lngIdx = headers.indexOf("shape_pt_lon");
      const seqIdx = headers.indexOf("shape_pt_sequence");

      const raw = new Map();
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        const id = cols[idIdx]?.trim();
        if (!id) continue;
        if (!raw.has(id)) raw.set(id, []);
        raw.get(id).push({
          seq: parseInt(cols[seqIdx]),
          lat: parseFloat(cols[latIdx]),
          lng: parseFloat(cols[lngIdx]),
        });
      }

      raw.forEach((points, id) => {
        shapePoints.set(
          id,
          points.sort((a, b) => a.seq - b.seq)
        );
      });

      console.log("Shapes loaded:", shapePoints.size);
    } catch (e) {
      console.warn("Could not load shapes", e);
    }
  }

  async function fetchRouteStops(routeNames) {
    try {
      const tripsRes = await fetch(`${API}/trips`);
      const tripsJson = await tripsRes.json();

      const tripsArray = Array.isArray(tripsJson)
        ? tripsJson
        : Object.entries(tripsJson.trips).map(([trip_id, t]) => ({
            trip_id,
            ...t,
          }));

      const tripToNormalizedRoute = new Map();
      for (const trip of tripsArray) {
        const shortName = routeNames[trip.route_id?.trim()];
        if (shortName) {
          tripToNormalizedRoute.set(trip.trip_id, normalize(shortName));
        }
      }

      for (const trip of tripsArray) {
        if (trip.trip_id && trip.shape_id) {
          tripShapeMap.set(trip.trip_id, trip.shape_id);
        }
      }
      console.log("tripShapeMap built:", tripShapeMap.size);

      routeStopIds = new Map();
      tripStopSequence = new Map();

      const activeTripIds = new Set(
        buses
          .map((b) => b.tripId)
          .filter((id) => id && tripToNormalizedRoute.has(id))
      );

      console.log("Active trips:", activeTripIds.size);

      for (const tripId of activeTripIds) {
        try {
          const res = await fetch(`${API}/schedule/${tripId}`);
          if (!res.ok) continue;

          const stops = await res.json();
          if (!stops.length) continue;

          const normalizedRoute = tripToNormalizedRoute.get(tripId);
          if (!normalizedRoute) continue;

          if (!routeStopIds.has(normalizedRoute)) {
            routeStopIds.set(normalizedRoute, new Set());
          }

          const orderedStops = stops
            .map((s) => ({
              stop_id: s.stop_id,
              seq: parseInt(s.stop_sequence),
            }))
            .sort((a, b) => a.seq - b.seq);

          tripStopSequence.set(tripId, orderedStops);

          for (const s of orderedStops) {
            routeStopIds.get(normalizedRoute).add(s.stop_id);
          }
        } catch (err) {
          console.warn(`Failed trip ${tripId}`, err);
        }
      }

      console.log("✅ Route stops loaded:", routeStopIds.size);
      console.log("✅ Trip sequences loaded:", tripStopSequence.size);
    } catch (e) {
      console.warn("❌ Could not load route stops", e);
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
        `<div class="stop-popup">
          <div class="stop-popup-name">${stop.stop_name}</div>
          <div class="stop-popup-code">Stop ${stop.stop_code}</div>
          <div class="stop-popup-empty">Loading arrivals...</div>
        </div>`,
        { maxWidth: 260 }
      )
      .openPopup();

    try {
      const res = await fetch(`${API}/stop-times/${stop.stop_id}`);
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
          </div>`);
        return;
      }

      const rows = upcoming
        .map((t) => {
          const [h, m] = t.arrival_time.split(":");
          return `<div class="stop-popup-row">
            <span class="stop-popup-time">${h}:${m}</span>
            <span class="stop-popup-trip">${t.trip_id}</span>
          </div>`;
        })
        .join("");

      marker.setPopupContent(`
        <div class="stop-popup">
          <div class="stop-popup-name">${stop.stop_name}</div>
          <div class="stop-popup-code">Stop ${stop.stop_code}</div>
          ${rows}
        </div>`);
    } catch (err) {
      marker.setPopupContent(`
        <div class="stop-popup">
          <div class="stop-popup-name">${stop.stop_name}</div>
          <div class="stop-popup-empty">Failed to load arrivals</div>
        </div>`);
    }
  }

  // Shows all stops within the current viewport when showStops is on
  function renderAllStops() {
    if (!allStopsLayerGroup) {
      allStopsLayerGroup = L.layerGroup().addTo(map);
    } else {
      allStopsLayerGroup.clearLayers();
    }

    if (!showStops) return;

    const bounds = map.getBounds().pad(0.05);

    allStops.forEach((stop) => {
      const lat = parseFloat(stop.stop_lat);
      const lng = parseFloat(stop.stop_lon);
      if (!bounds.contains([lat, lng])) return;

      const marker = L.marker([lat, lng], { icon: makeStopIcon() });
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        showStopPopup(marker, stop);
      });
      allStopsLayerGroup.addLayer(marker);
    });
  }

  function showStopsForTrip(tripId) {
    if (stopLayerGroup) stopLayerGroup.clearLayers();
    else stopLayerGroup = L.layerGroup().addTo(map);

    if (shapeLayerGroup) shapeLayerGroup.clearLayers();
    else shapeLayerGroup = L.layerGroup().addTo(map);

    if (!tripId) return;

    const stopsForTrip = tripStopSequence.get(tripId);
    if (!stopsForTrip || stopsForTrip.length === 0) return;

    const direction = getTripDirection(tripId);
    const isNorthbound = direction === "northbound";
    const lineColor = isNorthbound ? "#ff8c00" : "#00cfff";
    const arrowColor = isNorthbound ? "#ff8c00" : "#00cfff";

    const bounds = map.getBounds().pad(0.1);

    const orderedStops = stopsForTrip
      .map((s) => {
        const stop = allStops.find((st) => st.stop_id === s.stop_id);
        if (!stop) return null;
        return {
          ...stop,
          lat: parseFloat(stop.stop_lat),
          lng: parseFloat(stop.stop_lon),
        };
      })
      .filter(Boolean);

    if (orderedStops.length >= 2) {
      const shapeId = tripShapeMap.get(tripId);
      const shape = shapeId ? shapePoints.get(shapeId) : null;

      if (shape && shape.length >= 2) {
        L.polyline(
          shape.map((p) => [p.lat, p.lng]),
          {
            color: lineColor,
            weight: 3,
            opacity: 0.6,
            lineJoin: "round",
            lineCap: "round",
            dashArray: "6 4",
          }
        ).addTo(shapeLayerGroup);
      } else {
        L.polyline(
          orderedStops.map((s) => [s.lat, s.lng]),
          {
            color: lineColor,
            weight: 3,
            opacity: 0.6,
            lineJoin: "round",
            lineCap: "round",
            dashArray: "6 4",
          }
        ).addTo(shapeLayerGroup);
      }

      for (let i = 0; i < orderedStops.length - 1; i++) {
        const from = orderedStops[i];
        const to = orderedStops[i + 1];
        const bearing = calculateBearing(from.lat, from.lng, to.lat, to.lng);
        const midLat = (from.lat + to.lat) / 2;
        const midLng = (from.lng + to.lng) / 2;

        const arrowIcon = L.divIcon({
          className: "",
          html: `<svg
            width="20" height="20"
            viewBox="0 0 20 20"
            style="transform: rotate(${bearing}deg); display: block;"
            xmlns="http://www.w3.org/2000/svg">
            <polygon
              points="10,2 17,16 10,12 3,16"
              fill="${arrowColor}"
              fill-opacity="0.9"
              stroke="white"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
          </svg>`,
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        });

        L.marker([midLat, midLng], {
          icon: arrowIcon,
          interactive: false,
          zIndexOffset: -100,
        }).addTo(shapeLayerGroup);
      }
    }

    // Selected trip stop dots — always show when a bus is selected
    orderedStops.forEach((stop) => {
      if (!bounds.contains([stop.lat, stop.lng])) return;
      const marker = L.marker([stop.lat, stop.lng], { icon: makeStopIcon() });
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        showStopPopup(marker, stop);
      });
      stopLayerGroup.addLayer(marker);
    });
  }

  function makeBusIcon(
    bearing,
    dimmed = false,
    selected = false,
    direction = "unknown"
  ) {
    const rotation = bearing || 0;
    const flipped = rotation > 180 && rotation < 360;
    const glowColor = direction === "northbound" ? "orange" : "#00cfff";
    const selectedFilter = `drop-shadow(0 0 0px ${glowColor}) drop-shadow(0 0 8px ${glowColor})`;
    return L.divIcon({
      className: "",
      html: `
        <div class="bus-marker-wrap" style="
          opacity: ${dimmed ? 0.4 : 1};
          transform: ${selected ? "scale(1.4)" : "scale(1)"};
          filter: ${selected ? selectedFilter : "none"};
          transition: opacity 0.2s, filter 0.2s;
        ">
          <img
            src="${import.meta.env.BASE_URL}bus.png"
            class="bus-img"
            style="transform: rotate(${rotation - 90}deg) scaleX(-1) ${flipped ? "scaleY(-1)" : ""};"
          />
        </div>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      popupAnchor: [0, -20],
    });
  }

  async function fetchBuses(routeNames) {
    try {
      const res = await fetch(`${API}/vehicles`);
      if (!res.ok) return { buses: [], feedTimestamp: null };
      const buffer = await res.arrayBuffer();
      const feed = FeedMessage.decode(new Uint8Array(buffer));

      const feedTimestamp = feed.header?.timestamp
        ? Number(feed.header.timestamp) * 1000
        : null;

      const buses = feed.entity
        .map((e) => ({ id: e.id, vehicle: e.vehicle }))
        .filter(({ vehicle: v }) => v && v.position)
        .map(({ id, vehicle: v }) => {
          const routeId = v.trip?.routeId || "";
          const tripId = v.trip?.tripId || "";
          const routeName = routeNames[routeId] || "N/A";
          const stableId = v.vehicle?.id || v.vehicle?.label || id;
          return {
            id: stableId,
            routeName,
            tripId,
            lat: v.position.latitude,
            lng: v.position.longitude,
          };
        })
        .filter((bus) => isInDublin(bus.lat, bus.lng));

      return { buses, feedTimestamp };
    } catch (err) {
      console.error("Fetch buses failed:", err);
      return { buses: [], feedTimestamp: null };
    }
  }

  function shouldShow(normalizedRoute) {
    const term = normalize(searchTerm);
    const matchesSearch = !searchTerm || normalizedRoute.startsWith(term);
    const matchesFavourites =
      !favouritesMode || favourites.includes(normalizedRoute);
    return matchesSearch && matchesFavourites;
  }

  function isNearViewport(lat, lng) {
    const bounds = map.getBounds().pad(0.3);
    return bounds.contains([lat, lng]);
  }

  function applySearch() {
    if (!map || !clusterGroup) return;

    const visibleMarkers = [];

    busData.forEach((bus) => {
      const visible = shouldShow(bus.normalizedRoute);
      const inViewport = isNearViewport(bus.lat, bus.lng);

      if (visible && inViewport) {
        if (!clusterGroup.hasLayer(bus.marker)) {
          clusterGroup.addLayer(bus.marker);
        }
        visibleMarkers.push(bus.marker);
      } else {
        if (clusterGroup.hasLayer(bus.marker)) {
          clusterGroup.removeLayer(bus.marker);
        }
      }

      const isSelected =
        selectedRoute && bus.normalizedRoute === normalize(selectedRoute);
      const isDimmed = selectedRoute && !isSelected;
      const direction = getTripDirection(bus.tripId);
      bus.marker.setIcon(
        makeBusIcon(bus.bearing, isDimmed, isSelected, direction)
      );
    });

    if (shouldAutoFit && visibleMarkers.length > 0) {
      const group = L.featureGroup(visibleMarkers);
      map.fitBounds(group.getBounds().pad(0.05));
      shouldAutoFit = false;
    }

    showStopsForTrip(selectedTripId);
    renderAllStops();
  }

  function createMarker(bus, normalizedRoute) {
    return L.marker([bus.lat, bus.lng], { icon: makeBusIcon(bus.bearing) })
      .bindTooltip(bus.routeName, {
        permanent: true,
        direction: "top",
        className: "bus-label",
      })
      .on("click", async (e) => {
        L.DomEvent.stopPropagation(e);
        selectedRoute = normalizedRoute;
        selectedTripId = bus.tripId;

        if (!tripStopSequence.has(bus.tripId)) {
          try {
            const res = await fetch(`${API}/schedule/${bus.tripId}`);
            if (res.ok) {
              const stops = await res.json();
              const ordered = stops
                .map((s) => ({
                  stop_id: s.stop_id,
                  seq: parseInt(s.stop_sequence),
                }))
                .sort((a, b) => a.seq - b.seq);
              tripStopSequence.set(bus.tripId, ordered);
            }
          } catch (err) {
            console.warn("Failed to load stops for trip", bus.tripId, err);
          }
        }

        applySearch();
      });
  }

  async function refreshBuses(routeNames, isBackground = false) {
    if (isFetching) return;
    isFetching = true;

    try {
      const { buses: newBuses, feedTimestamp } = await fetchBuses(routeNames);
      const incomingIds = new Set(newBuses.map((b) => b.id));

      if (!isBackground) {
        clusterGroup.clearLayers();
      }

      busData.forEach((entry, id) => {
        if (!incomingIds.has(id)) {
          clusterGroup.removeLayer(entry.marker);
          busData.delete(id);
        }
      });

      newBuses.forEach((newBus) => {
        const normalizedRoute = normalize(newBus.routeName);
        const bearing = resolveBearing(newBus);

        if (busData.has(newBus.id)) {
          const entry = busData.get(newBus.id);
          entry.lat = newBus.lat;
          entry.lng = newBus.lng;
          entry.bearing = bearing;
          entry.tripId = newBus.tripId;
          entry.normalizedRoute = normalizedRoute;
          entry.marker.setLatLng([newBus.lat, newBus.lng]);
          const isSelected =
            selectedRoute && normalizedRoute === normalize(selectedRoute);
          const isDimmed = selectedRoute && !isSelected;
          const direction = getTripDirection(newBus.tripId);
          entry.marker.setIcon(
            makeBusIcon(bearing, isDimmed, isSelected, direction)
          );
        } else {
          const marker = createMarker({ ...newBus, bearing }, normalizedRoute);
          busData.set(newBus.id, {
            ...newBus,
            bearing,
            normalizedRoute,
            marker,
          });
        }
      });

      buses = newBuses;

      if (feedTimestamp && feedTimestamp !== lastUpdated) {
        lastUpdated = feedTimestamp;
      }

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
      map.setView(locationMarker.getLatLng(), 17);
    }
  }

  let routeNamesGlobal = {};

  function refreshPage() {
    refreshBuses(routeNamesGlobal, false);
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
      selectedTripId = "";
      if (shapeLayerGroup) shapeLayerGroup.clearLayers();
      if (stopLayerGroup) stopLayerGroup.clearLayers();
      applySearch();
    });

    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
        updateWhenIdle: false,
        updateWhenZooming: true,
      }
    ).addTo(map);

    const protoUrl = import.meta.env.BASE_URL + "gtfs-realtime.proto";

    const [root, routeNames] = await Promise.all([
      protobuf.load(protoUrl),
      fetchRouteNames(),
      fetchStops(),
      fetchShapes(),
    ]);

    routeNamesGlobal = routeNames;
    FeedMessage = root.lookupType("transit_realtime.FeedMessage");

    await refreshBuses(routeNames, false);

    fetchRouteStops(routeNames).then(() => {
      applySearch();
    });

    setInterval(() => refreshBuses(routeNames, true), 15000);

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
            map.setView([latitude, longitude], 17);
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
    showStops;
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
