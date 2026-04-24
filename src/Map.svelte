<script>
  import { onMount, createEventDispatcher } from "svelte";
  import L from "leaflet";
  import "leaflet.markercluster";
  import protobuf from "protobufjs";

  const dispatch = createEventDispatcher();

  export let searchTerm = "",
    favourites = [],
    favouritesMode = false;
  export let showStops = true,
    showBuses = true,
    savedStops = [];

  let map, mapContainer, clusterGroup, locationMarker;
  let shapeLayerGroup, stopLayerGroup, allStopsLayerGroup;
  let selectedStopMarker,
    isFetching = false,
    FeedMessage;

  let busData = new Map();
  let shapePoints = new Map(),
    tripShapeMap = new Map();
  let tripStopSequence = new Map(),
    stopLatLng = new Map();
  let routeStopIds = new Map();
  let tripRouteNameMap = new Map();
  let tripSuffixToStaticId = new Map();

  let buses = [],
    allStops = [];
  let selectedRoute = "",
    selectedTripId = "",
    selectedStop = null;
  let stopPanelStop = null,
    stopPanelArrivals = [],
    stopPanelLoading = false;
  let incomingTripIds = new Set();
  let lastUpdated = null,
    timeSinceUpdate = "";
  let shouldAutoFit = false;
  let backoffDelay = 30000,
    lastManualRefresh = 0;
  let routeNamesGlobal = {};
  let followingBus = false; // true when user double-clicked a bus to lock-follow it

  const STOPS_MIN_ZOOM = 14;
  const API = "https://bus-times.ciaranjmcgann.workers.dev";
  const DUBLIN_BOUNDS = {
    minLat: 53.14,
    maxLat: 53.46,
    minLng: -6.63,
    maxLng: -6.0,
  };

  // ── Utilities ──────────────────────────────────────────────────
  const isInDublin = (lat, lng) =>
    lat >= DUBLIN_BOUNDS.minLat &&
    lat <= DUBLIN_BOUNDS.maxLat &&
    lng >= DUBLIN_BOUNDS.minLng &&
    lng <= DUBLIN_BOUNDS.maxLng;

  const normalize = (str) => (str || "").replace(/\s/g, "").toLowerCase();

  const timeToMins = (t) => {
    if (!t) return null;
    const [h, m, s] = t.split(":").map(Number);
    return h * 60 + m + (s || 0) / 60;
  };

  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  function calculateBearing(lat1, lng1, lat2, lng2) {
    const dLng = toRad(lng2 - lng1);
    const y = Math.sin(dLng) * Math.cos(toRad(lat2));
    const x =
      Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function resolveStaticTripId(liveTripId) {
    if (!liveTripId) return liveTripId;
    if (tripStopSequence.has(liveTripId)) return liveTripId;
    const suffix = liveTripId.split("_")[1];
    return suffix && tripSuffixToStaticId.has(suffix)
      ? tripSuffixToStaticId.get(suffix)
      : liveTripId;
  }

  function calcEstMinutes(stops, nearestIdx, targetIdx) {
    const from = timeToMins(stops[nearestIdx]?.arrival_time);
    const to = timeToMins(stops[targetIdx]?.arrival_time);
    return from !== null && to !== null && to > from
      ? Math.round(to - from)
      : Math.round((targetIdx - nearestIdx) * 1.5);
  }

  function updateTimer() {
    if (!lastUpdated) return;
    timeSinceUpdate = `Updated ${Math.floor((Date.now() - lastUpdated) / 1000)}s ago`;
  }

  // ── Bearing resolution ─────────────────────────────────────────
  function nearestStopIdx(stops, lat, lng) {
    let bestIdx = 0,
      bestDist = Infinity;
    for (let i = 0; i < stops.length; i++) {
      const s = stopLatLng.get(stops[i].stop_id);
      if (!s) continue;
      const d = (s.lat - lat) ** 2 + (s.lng - lng) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function getBearingFromStops(tripId, lat, lng) {
    const stops =
      tripStopSequence.get(resolveStaticTripId(tripId)) ||
      tripStopSequence.get(tripId);
    if (!stops || stops.length < 2) return null;
    const i = nearestStopIdx(stops, lat, lng);
    const j = Math.min(i + 1, stops.length - 1);
    const from = stopLatLng.get(stops[i].stop_id);
    const to = stopLatLng.get(stops[j].stop_id);
    if (!from || !to || (from.lat === to.lat && from.lng === to.lng))
      return null;
    return calculateBearing(from.lat, from.lng, to.lat, to.lng);
  }

  function getBearingFromShape(shapeId, lat, lng) {
    const pts = shapePoints.get(shapeId);
    if (!pts || pts.length < 2) return null;
    let best = null,
      bestDist = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const mid = {
        lat: (pts[i].lat + pts[i + 1].lat) / 2,
        lng: (pts[i].lng + pts[i + 1].lng) / 2,
      };
      const d = (mid.lat - lat) ** 2 + (mid.lng - lng) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = calculateBearing(
          pts[i].lat,
          pts[i].lng,
          pts[i + 1].lat,
          pts[i + 1].lng
        );
      }
    }
    return best;
  }

  function resolveBearing({ tripId, lat, lng }) {
    const staticId = resolveStaticTripId(tripId);
    const shapeId = tripShapeMap.get(staticId) || tripShapeMap.get(tripId);
    if (shapeId) {
      const shapeBearing = getBearingFromShape(shapeId, lat, lng);
      if (shapeBearing !== null) return shapeBearing;
    }
    return getBearingFromStops(tripId, lat, lng) ?? 0;
  }

  // ── Shape distance filter ──────────────────────────────────────
  // Returns the distance (in degrees, approx) from (lat, lng) to the nearest
  // point on the bus's shape polyline. Returns 0 if no shape is loaded yet
  // so that buses are never hidden just because shapes haven't arrived.
  function distanceFromShape(tripId, lat, lng) {
    const staticId = resolveStaticTripId(tripId);
    const shapeId = tripShapeMap.get(staticId) || tripShapeMap.get(tripId);
    const pts = shapeId ? shapePoints.get(shapeId) : null;
    if (!pts || pts.length < 2) return 0; // no shape loaded yet → don't filter

    let bestDist = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = (pts[i].lat - lat) ** 2 + (pts[i].lng - lng) ** 2;
      if (d < bestDist) bestDist = d;
    }
    return Math.sqrt(bestDist);
  }

  function getTripDirection(tripId) {
    const stops =
      tripStopSequence.get(resolveStaticTripId(tripId)) ||
      tripStopSequence.get(tripId);
    if (!stops || stops.length < 2) return "unknown";
    const first = stopLatLng.get(stops[0].stop_id);
    const last = stopLatLng.get(stops[stops.length - 1].stop_id);
    if (!first || !last) return "unknown";
    return last.lat > first.lat ? "northbound" : "southbound";
  }

  // ── Stop panel helpers ─────────────────────────────────────────
  function getIncomingTripsForStop(stopId) {
    const result = new Set();
    tripStopSequence.forEach((stops, staticTripId) => {
      const targetIdx = stops.findIndex((s) => s.stop_id === stopId);
      if (targetIdx === -1) return;
      let liveBus = null;
      busData.forEach((bus) => {
        if (resolveStaticTripId(bus.tripId) === staticTripId) liveBus = bus;
      });
      if (!liveBus) return;
      const i = nearestStopIdx(stops, liveBus.lat, liveBus.lng);
      if (i < targetIdx) result.add(staticTripId);
    });
    return result;
  }

  function clearSelectedStop() {
    selectedStop = stopPanelStop = null;
    stopPanelArrivals = [];
    incomingTripIds = new Set();
    followingBus = false;
    if (selectedStopMarker) {
      if (map.hasLayer(selectedStopMarker)) map.removeLayer(selectedStopMarker);
      selectedStopMarker = null;
    }
  }

  const isStopSaved = (stopId) => savedStops.some((s) => s.stop_id === stopId);
  const toggleSaveStop = (stop) => dispatch("toggleSavedStop", stop);

  function fitBoundsWithPanel(bounds) {
    map.fitBounds(bounds, {
      paddingTopLeft: [60, 60],
      paddingBottomRight: [60, 380],
      maxZoom: 16,
    });
  }

  // ── Icons ──────────────────────────────────────────────────────
  function makeStopIcon(highlighted = false) {
    return L.divIcon({
      className: "",
      html: `<div class="stop-marker${highlighted ? " stop-marker-highlighted" : ""}"></div>`,
      iconSize: highlighted ? [18, 18] : [12, 12],
      iconAnchor: highlighted ? [9, 9] : [6, 6],
    });
  }

  function makeBusIcon(
    bearing,
    dimmed,
    selected,
    highlighted,
    direction,
    routeName = ""
  ) {
    const rotation = bearing || 0;
    const flipped = rotation > 180;
    const glow = highlighted
      ? "#00e676"
      : direction === "northbound"
        ? "orange"
        : "#00cfff";
    return L.divIcon({
      className: "",
      html: `<div class="bus-marker-outer" style="opacity:${dimmed ? 0.2 : 1};transition:opacity 0.2s;">
        <div class="bus-route-label">${routeName}</div>
        <div class="bus-marker-wrap" style="
          transform:${selected || highlighted ? "scale(1.4)" : "scale(1)"};
          filter:${selected || highlighted ? `drop-shadow(0 0 0px ${glow}) drop-shadow(0 0 8px ${glow})` : "none"};
          transition:filter 0.2s,transform 0.2s;">
         <img src="${import.meta.env.BASE_URL}dublinbus.png"
  class="bus-img"
  style="
    width:60px;
    transform:rotate(${rotation - 90}deg) scaleX(-1)${flipped ? " scaleY(-1)" : ""}
  "/>
        </div>
      </div>`,
      iconSize: [24, 32],
      iconAnchor: [12, 28],
      popupAnchor: [0, -46],
    });
  }

  // ── Data fetching ──────────────────────────────────────────────
  async function fetchRouteNames() {
    try {
      const routes = await fetch(`${API}/routes`).then((r) => r.json());
      return routes.reduce((acc, r) => {
        if (!r.route_id || !r.route_short_name) return acc;
        const key = r.route_id.trim(),
          name = r.route_short_name.trim();
        acc[key] = name;
        const shortKey = key.split("-")[0];
        if (!acc[shortKey]) acc[shortKey] = name;
        return acc;
      }, {});
    } catch {
      return {};
    }
  }

  async function fetchStops() {
    try {
      const data = await fetch(`${API}/static/stops.json`).then((r) =>
        r.json()
      );
      const arr = Array.isArray(data) ? data : Object.values(data);
      allStops = arr.filter(
        (s) => s.stop_lat && s.stop_lon && isInDublin(+s.stop_lat, +s.stop_lon)
      );
      for (const s of arr) {
        if (s.stop_id && s.stop_lat && s.stop_lon)
          stopLatLng.set(s.stop_id, { lat: +s.stop_lat, lng: +s.stop_lon });
      }
      dispatch("stopsLoaded", allStops);
    } catch {
      console.warn("Could not load stops");
    }
  }

  async function fetchShapes() {
    try {
      const text = await fetch(`${API}/static/shapes.txt`).then((r) =>
        r.text()
      );
      const clean = text
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/^\uFEFF/, "");
      const [header, ...lines] = clean.trim().split("\n");
      const h = header.split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
      const [idIdx, latIdx, lngIdx, seqIdx] = [
        "shape_id",
        "shape_pt_lat",
        "shape_pt_lon",
        "shape_pt_sequence",
      ].map((k) => h.indexOf(k));
      if ([idIdx, latIdx, lngIdx, seqIdx].includes(-1)) {
        console.warn("[shapes] missing columns, headers:", h);
        return;
      }
      const raw = new Map();
      for (const line of lines) {
        if (!line.trim()) continue;
        const c = line.split(",");
        const id = c[idIdx]?.trim().replace(/^"|"$/g, "");
        const lat = parseFloat(c[latIdx]);
        const lng = parseFloat(c[lngIdx]);
        const seq = parseInt(c[seqIdx]);
        if (!id || isNaN(lat) || isNaN(lng) || isNaN(seq)) continue;
        if (!raw.has(id)) raw.set(id, []);
        raw.get(id).push({ seq, lat, lng });
      }
      raw.forEach((pts, id) =>
        shapePoints.set(
          id,
          pts.sort((a, b) => a.seq - b.seq)
        )
      );
      console.log(`[shapes] loaded ${shapePoints.size} shapes`);
      if (selectedTripId) applySearch();
    } catch (e) {
      console.warn("Could not load shapes", e);
    }
  }

  async function fetchTripSchedule(tripId) {
    const key = `trip-${tripId}`;
    try {
      const c = sessionStorage.getItem(key);
      if (c) return JSON.parse(c);
    } catch {}
    const res = await fetch(`${API}/schedule/${tripId}`);
    if (!res.ok) return null;
    const stops = await res.json();
    try {
      sessionStorage.setItem(key, JSON.stringify(stops));
    } catch {}
    return stops;
  }

  function indexTrips(tripsJson, routeNames) {
    const arr = Array.isArray(tripsJson)
      ? tripsJson
      : Object.entries(tripsJson.trips ?? tripsJson).map(([trip_id, t]) => ({
          trip_id,
          ...t,
        }));

    for (const trip of arr) {
      const name = routeNames[trip.route_id?.trim()];
      if (name) {
        tripRouteNameMap.set(trip.trip_id, name);
        const suffix = trip.trip_id?.split("_")[1];
        if (suffix) {
          tripRouteNameMap.set(suffix, name);
          tripSuffixToStaticId.set(suffix, trip.trip_id);
        }
      }
    }

    return arr;
  }

  async function fetchTripRouteNames(routeNames) {
    try {
      indexTrips(await fetch(`${API}/trips`).then((r) => r.json()), routeNames);
    } catch (e) {
      console.warn("Could not build tripRouteNameMap", e);
    }
  }

  function matchTripsToShapes() {
    if (!shapePoints.size || !stopLatLng.size) return;

    const shapeStarts = [];
    shapePoints.forEach((pts, shapeId) => {
      if (pts.length)
        shapeStarts.push({ shapeId, lat: pts[0].lat, lng: pts[0].lng });
    });

    tripStopSequence.forEach((stops, tripId) => {
      if (tripShapeMap.has(tripId)) return;
      let firstLL = null;
      for (const s of stops) {
        firstLL = stopLatLng.get(s.stop_id);
        if (firstLL) break;
      }
      if (!firstLL) return;

      let bestShape = null,
        bestDist = Infinity;
      for (const { shapeId, lat, lng } of shapeStarts) {
        const d = (lat - firstLL.lat) ** 2 + (lng - firstLL.lng) ** 2;
        if (d < bestDist) {
          bestDist = d;
          bestShape = shapeId;
        }
      }
      if (bestShape) tripShapeMap.set(tripId, bestShape);
    });

    console.log(
      "[shapes] matched trips→shapes, tripShapeMap size:",
      tripShapeMap.size
    );
    if (selectedTripId) applySearch();
  }

  async function fetchRouteStops(routeNames) {
    try {
      const tripsArr = indexTrips(
        await fetch(`${API}/trips`).then((r) => r.json()),
        routeNames
      );
      const tripToRoute = new Map();
      for (const trip of tripsArr) {
        const name = routeNames[trip.route_id?.trim()];
        if (name) tripToRoute.set(trip.trip_id, normalize(name));
      }

      routeStopIds = new Map();

      // Collect all live trip IDs, falling back to all known trip IDs if buses
      // haven't loaded yet (shouldn't happen, but defensive)
      const liveTripIds = buses.map((b) => b.tripId).filter(Boolean);
      const active = [
        ...new Set(liveTripIds.length ? liveTripIds : [...tripToRoute.keys()]),
      ];

      for (let i = 0; i < active.length; i += 10) {
        await Promise.all(
          active.slice(i, i + 10).map(async (tripId) => {
            const sid = resolveStaticTripId(tripId);
            if (tripStopSequence.has(sid)) return; // already loaded
            const stops = await fetchTripSchedule(sid).catch(() => null);
            if (!stops?.length) return;
            const nr = tripToRoute.get(tripId) || tripToRoute.get(sid);
            if (nr) {
              if (!routeStopIds.has(nr)) routeStopIds.set(nr, new Set());
              for (const s of stops) routeStopIds.get(nr).add(s.stop_id);
            }
            const ordered = stops
              .map((s) => ({
                stop_id: s.stop_id,
                seq: +s.stop_sequence,
                arrival_time: s.arrival_time || s.departure_time || null,
              }))
              .sort((a, b) => a.seq - b.seq);
            tripStopSequence.set(sid, ordered);
          })
        );
      }
      console.log(
        "[fetchRouteStops] tripStopSequence size:",
        tripStopSequence.size
      );
    } catch {
      console.warn("Could not load route stops");
    }
  }

  // Re-evaluate all buses currently in busData against the shape filter.
  // Called after shapes are matched so buses that were admitted before shapes
  // were ready get a second chance to be culled if they're off-route.
  function refilterBusesAfterShapeMatch() {
    if (!busData.size) return;
    let removed = 0;
    busData.forEach((entry, id) => {
      const dist = distanceFromShape(entry.tripId, entry.lat, entry.lng);
      if (dist > 0.001) {
        clusterGroup.removeLayer(entry.marker);
        busData.delete(id);
        removed++;
      }
    });
    if (removed > 0) {
      console.log(
        `[filter] removed ${removed} off-route buses after shape match`
      );
      applySearch();
    }
  }

  async function fetchBuses(routeNames) {
    try {
      const res = await fetch(`${API}/vehicles`);
      if (res.status === 429) {
        backoffDelay = Math.min(backoffDelay * 2, 120000);
        return { buses: [], feedTimestamp: null };
      }
      backoffDelay = 30000;
      if (!res.ok) return { buses: [], feedTimestamp: null };
      const feed = FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
      const feedTimestamp = feed.header?.timestamp
        ? +feed.header.timestamp * 1000
        : null;
      const result = feed.entity
        .filter((e) => e.vehicle?.position)
        .map(({ id, vehicle: v }) => {
          const routeId = v.trip?.routeId || "",
            tripId = v.trip?.tripId || "";
          const suffix = tripId.split("_")[1] || "";
          const routeName =
            tripRouteNameMap.get(tripId) ||
            tripRouteNameMap.get(suffix) ||
            routeNames[routeId] ||
            "N/A";
          return {
            id: v.vehicle?.id || v.vehicle?.label || id,
            routeName,
            tripId,
            lat: v.position.latitude,
            lng: v.position.longitude,
          };
        })
        .filter((b) => isInDublin(b.lat, b.lng));
      return { buses: result, feedTimestamp };
    } catch {
      return { buses: [], feedTimestamp: null };
    }
  }

  // ── Rendering ──────────────────────────────────────────────────
  function renderAllStops() {
    allStopsLayerGroup ||= L.layerGroup().addTo(map);
    allStopsLayerGroup.clearLayers();
    if (stopPanelStop || !showStops || map.getZoom() < STOPS_MIN_ZOOM) return;
    const src = favouritesMode
      ? allStops.filter((s) =>
          savedStops.some((ss) => ss.stop_id === s.stop_id)
        )
      : allStops;
    const bounds = map.getBounds().pad(0.05);
    for (const stop of src) {
      const lat = +stop.stop_lat,
        lng = +stop.stop_lon;
      if (!bounds.contains([lat, lng])) continue;
      const m = L.marker([lat, lng], { icon: makeStopIcon() });
      m.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        openStopPanel(stop);
      });
      allStopsLayerGroup.addLayer(m);
    }
  }

  function showStopsForTrip(rawTripId) {
    stopLayerGroup ||= L.layerGroup().addTo(map);
    shapeLayerGroup ||= L.layerGroup().addTo(map);
    stopLayerGroup.clearLayers();
    shapeLayerGroup.clearLayers();
    if (!rawTripId) return;

    const tripId = resolveStaticTripId(rawTripId);
    const stopsForTrip =
      tripStopSequence.get(tripId) || tripStopSequence.get(rawTripId);
    if (!stopsForTrip?.length) return;

    const isNorth = getTripDirection(tripId) === "northbound";
    const lineColor = isNorth ? "#ff8c00" : "#00cfff";
    const bounds = map.getBounds().pad(0.1);

    const ordered = stopsForTrip
      .map((s) => {
        const stop = allStops.find((st) => st.stop_id === s.stop_id);
        return stop
          ? { ...stop, lat: +stop.stop_lat, lng: +stop.stop_lon }
          : null;
      })
      .filter(Boolean);

    if (ordered.length >= 2) {
      const staticId = resolveStaticTripId(tripId);
      const shapeId =
        tripShapeMap.get(staticId) ||
        tripShapeMap.get(tripId) ||
        tripShapeMap.get(rawTripId);
      const shape = shapeId ? shapePoints.get(shapeId) : null;
      const useShape = shape && shape.length >= 2;

      console.log("[route] rawTripId:", rawTripId, "→ staticId:", staticId);
      const polyPts = useShape
        ? shape.map((p) => [p.lat, p.lng])
        : ordered.map((s) => [s.lat, s.lng]);
      L.polyline(polyPts, {
        color: lineColor,
        weight: 3,
        opacity: 0.6,
        dashArray: "6 4",
        lineJoin: "round",
        lineCap: "round",
      }).addTo(shapeLayerGroup);

      const arrowSrc = useShape
        ? shape
        : ordered.map((s) => ({ lat: s.lat, lng: s.lng }));
      const step = useShape
        ? Math.max(1, Math.floor(arrowSrc.length / Math.min(ordered.length, 8)))
        : 1;
      for (let i = 0; i < arrowSrc.length - 1; i += step) {
        const a = arrowSrc[i],
          b = arrowSrc[Math.min(i + step, arrowSrc.length - 1)];
        const bearing = calculateBearing(a.lat, a.lng, b.lat, b.lng);
        L.marker([(a.lat + b.lat) / 2, (a.lng + b.lng) / 2], {
          icon: L.divIcon({
            className: "",
            html: `<svg width="20" height="20" viewBox="0 0 20 20" style="transform:rotate(${bearing}deg);display:block" xmlns="http://www.w3.org/2000/svg"><polygon points="10,2 17,16 10,12 3,16" fill="${lineColor}" fill-opacity="0.9" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          }),
          interactive: false,
          zIndexOffset: -100,
        }).addTo(shapeLayerGroup);
      }
    }

    if (!stopPanelStop) {
      for (const stop of ordered) {
        if (!bounds.contains([stop.lat, stop.lng])) continue;
        const m = L.marker([stop.lat, stop.lng], { icon: makeStopIcon() });
        m.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          openStopPanel(stop);
        });
        stopLayerGroup.addLayer(m);
      }
    }
  }

  function ensureSelectedStopMarker() {
    if (!selectedStop) return;
    const lat = +selectedStop.stop_lat,
      lng = +selectedStop.stop_lon;
    if (selectedStopMarker && map.hasLayer(selectedStopMarker)) {
      selectedStopMarker.setIcon(makeStopIcon(true));
    } else {
      if (selectedStopMarker && map.hasLayer(selectedStopMarker))
        map.removeLayer(selectedStopMarker);
      selectedStopMarker = L.marker([lat, lng], {
        icon: makeStopIcon(true),
        zIndexOffset: 500,
      }).addTo(map);
      selectedStopMarker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        openStopPanel(selectedStop);
      });
    }
  }

  function applySearch() {
    if (!map || !clusterGroup) return;
    const visibleMarkers = [],
      hasStop = !!selectedStop,
      hasRoute = !!selectedRoute;

    busData.forEach((bus) => {
      const isFollowed = followingBus && bus.tripId === selectedTripId;

      // When following a specific bus, hide everything else completely
      if (followingBus && !isFollowed) {
        if (clusterGroup.hasLayer(bus.marker))
          clusterGroup.removeLayer(bus.marker);
        return;
      }

      const visible =
        showBuses &&
        (hasStop
          ? normalize(bus.normalizedRoute).includes(normalize(searchTerm)) ||
            !searchTerm
          : shouldShow(bus.normalizedRoute));
      const inViewport = map.getBounds().pad(0.3).contains([bus.lat, bus.lng]);
      const isIncoming = incomingTripIds.has(resolveStaticTripId(bus.tripId));
      const isSelected =
        hasRoute && bus.normalizedRoute === normalize(selectedRoute);
      const dimmed =
        hasStop && selectedTripId
          ? bus.tripId !== selectedTripId
          : hasStop
            ? !isIncoming
            : hasRoute
              ? !isSelected
              : false;

      if (visible && inViewport && !dimmed) {
        if (!clusterGroup.hasLayer(bus.marker))
          clusterGroup.addLayer(bus.marker);
        visibleMarkers.push(bus.marker);
      } else {
        if (clusterGroup.hasLayer(bus.marker))
          clusterGroup.removeLayer(bus.marker);
      }
      bus.marker.setIcon(
        makeBusIcon(
          bus.bearing,
          false,
          isSelected && !followingBus,
          isFollowed || (isIncoming && hasStop && !selectedTripId),
          getTripDirection(bus.tripId),
          bus.routeName
        )
      );
    });

    if (shouldAutoFit && visibleMarkers.length) {
      map.fitBounds(L.featureGroup(visibleMarkers).getBounds().pad(0.05));
      shouldAutoFit = false;
    }
    showStopsForTrip(resolveStaticTripId(selectedTripId));
    renderAllStops();
    ensureSelectedStopMarker();
  }

  const shouldShow = (nr) =>
    (!searchTerm || nr === normalize(searchTerm)) &&
    (!favouritesMode || favourites.includes(nr));

  function createMarker(bus, normalizedRoute) {
    // Compute initial bearing from shape so direction is correct at first load
    const initialBearing = resolveBearing({
      tripId: bus.tripId,
      lat: bus.lat,
      lng: bus.lng,
    });
    const bearing = initialBearing || bus.bearing || 0;
    return L.marker([bus.lat, bus.lng], {
      icon: makeBusIcon(
        bearing,
        false,
        false,
        false,
        getTripDirection(bus.tripId),
        bus.routeName
      ),
    }).on("click", async (e) => {
      L.DomEvent.stopPropagation(e);

      const alreadySelected = selectedTripId === bus.tripId;

      if (alreadySelected && !followingBus) {
        // Second click on same bus — enter follow mode, close stop panel
        followingBus = true;
        clearSelectedStop(); // closes stop panel, clears stop marker
        selectedRoute = normalizedRoute;
        selectedTripId = bus.tripId;
        const cur = busData.get(bus.id);
        if (cur)
          map.setView([cur.lat, cur.lng], Math.max(map.getZoom(), 16), {
            animate: true,
          });
        applySearch();
        return;
      }

      if (alreadySelected && followingBus) {
        // Third click (or click while following) — deselect entirely
        followingBus = false;
        selectedRoute = "";
        selectedTripId = "";
        shapeLayerGroup?.clearLayers();
        stopLayerGroup?.clearLayers();
        applySearch();
        return;
      }

      // First click — select bus, show route, but don't follow yet
      followingBus = false;
      clearSelectedStop();
      selectedRoute = normalizedRoute;
      selectedTripId = bus.tripId;
      const sid = resolveStaticTripId(bus.tripId);
      if (!tripStopSequence.has(sid)) {
        const stops = await fetchTripSchedule(sid).catch(() => null);
        if (stops) {
          tripStopSequence.set(
            sid,
            stops
              .map((s) => ({ stop_id: s.stop_id, seq: +s.stop_sequence }))
              .sort((a, b) => a.seq - b.seq)
          );
          matchTripsToShapes();
        }
      }
      const cur = busData.get(bus.id);
      if (cur)
        map.setView([cur.lat, cur.lng], Math.max(map.getZoom(), 16), {
          animate: true,
        });
      applySearch();
    });
  }

  async function refreshBuses(routeNames, isBackground = false) {
    if (isFetching) return;
    isFetching = true;
    try {
      const { buses: newBuses, feedTimestamp } = await fetchBuses(routeNames);
      const incoming = new Set(newBuses.map((b) => b.id));
      if (!isBackground) clusterGroup.clearLayers();
      busData.forEach((entry, id) => {
        if (!incoming.has(id)) {
          clusterGroup.removeLayer(entry.marker);
          busData.delete(id);
        }
      });

      for (const newBus of newBuses) {
        const nr = normalize(newBus.routeName),
          bearing = resolveBearing(newBus);

        // Filter out buses that are too far from their route shape.
        // Returns 0 if no shape loaded yet, so buses are never hidden at startup.
        const distFromRoute = distanceFromShape(
          newBus.tripId,
          newBus.lat,
          newBus.lng
        );
        if (distFromRoute > 0.001) {
          // Remove from map if it was previously shown
          if (busData.has(newBus.id)) {
            clusterGroup.removeLayer(busData.get(newBus.id).marker);
            busData.delete(newBus.id);
          }
          continue;
        }

        if (busData.has(newBus.id)) {
          const e = busData.get(newBus.id);
          Object.assign(e, {
            lat: newBus.lat,
            lng: newBus.lng,
            bearing,
            tripId: newBus.tripId,
            normalizedRoute: nr,
          });
          e.marker.setLatLng([newBus.lat, newBus.lng]);
          e.marker.setIcon(
            makeBusIcon(
              bearing,
              false,
              false,
              false,
              getTripDirection(newBus.tripId),
              newBus.routeName
            )
          );
        } else {
          busData.set(newBus.id, {
            ...newBus,
            bearing,
            normalizedRoute: nr,
            marker: createMarker({ ...newBus, bearing }, nr),
          });
        }
      }
      buses = newBuses;
      if (feedTimestamp && feedTimestamp !== lastUpdated)
        lastUpdated = feedTimestamp;
      if (selectedStop) {
        incomingTripIds = getIncomingTripsForStop(selectedStop.stop_id);
        await refreshStopArrivals(selectedStop);
      }
      if (followingBus && selectedTripId) {
        const followed = [...busData.values()].find(
          (b) => b.tripId === selectedTripId
        );
        if (followed)
          map.panTo([followed.lat, followed.lng], {
            animate: true,
            duration: 0.8,
          });
      }
      updateTimer();
      applySearch();
    } finally {
      isFetching = false;
    }
  }

  async function refreshStopArrivals(stop) {
    const trips = [];
    tripStopSequence.forEach((stops, staticTripId) => {
      const targetIdx = stops.findIndex((s) => s.stop_id === stop.stop_id);
      if (targetIdx === -1) return;
      let liveBus = null;
      busData.forEach((bus) => {
        if (resolveStaticTripId(bus.tripId) === staticTripId) liveBus = bus;
      });
      if (!liveBus) return;
      const i = nearestStopIdx(stops, liveBus.lat, liveBus.lng);
      if (i >= targetIdx) return;
      trips.push({
        tripId: liveBus.tripId,
        staticTripId,
        routeName: liveBus.routeName,
        normalizedRoute: liveBus.normalizedRoute,
        estMinutes: calcEstMinutes(stops, i, targetIdx),
        type: "live",
      });
    });

    trips.sort((a, b) => a.estMinutes - b.estMinutes);
    if (trips.length) {
      stopPanelArrivals = trips.slice(0, 8);
      return;
    }

    try {
      const times = await fetch(`${API}/stop-times/${stop.stop_id}`).then((r) =>
        r.json()
      );
      const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
      stopPanelArrivals = times
        .map((t) => {
          const [h, m] = t.arrival_time.split(":").map(Number);
          return { ...t, totalMins: h * 60 + m };
        })
        .filter((t) => t.totalMins >= nowMins)
        .slice(0, 8)
        .map((t) => ({
          routeName: t.trip_id,
          tripId: null,
          estMinutes: t.totalMins - nowMins,
          arrivalTime: t.arrival_time,
          type: "scheduled",
        }));
    } catch {}
  }

  async function openStopPanel(stop) {
    if (stopPanelStop?.stop_id === stop.stop_id) {
      clearSelectedStop();
      applySearch();
      return;
    }
    selectedStop = stop;
    stopPanelStop = stop;
    stopPanelArrivals = [];
    stopPanelLoading = true;
    selectedTripId = "";
    selectedRoute = "";

    const lat = +stop.stop_lat,
      lng = +stop.stop_lon;
    setTimeout(() => {
      map.setView([lat, lng], Math.max(map.getZoom(), 16), { animate: true });
      setTimeout(
        () => map.panBy([0, 160], { animate: true, duration: 0.3 }),
        350
      );
    }, 50);
    applySearch();

    try {
      const unfetched = [...busData.values()]
        .map((b) => b.tripId)
        .filter((id) => id && !tripStopSequence.has(id));
      await Promise.all(
        unfetched.map(async (liveTripId) => {
          const sid = resolveStaticTripId(liveTripId);
          if (tripStopSequence.has(sid)) return;
          const stops = await fetchTripSchedule(sid).catch(() => null);
          if (!stops?.length) return;
          tripStopSequence.set(
            sid,
            stops
              .map((s) => ({
                stop_id: s.stop_id,
                seq: +s.stop_sequence,
                arrival_time: s.arrival_time || s.departure_time || null,
              }))
              .sort((a, b) => a.seq - b.seq)
          );
        })
      );
      incomingTripIds = getIncomingTripsForStop(stop.stop_id);
      await refreshStopArrivals(stop);
    } finally {
      stopPanelLoading = false;
    }
  }

  function handleArrivalClick(arrival) {
    if (arrival.type !== "live" || !arrival.tripId) return;
    const entry = [...busData.values()].find(
      (b) => b.tripId === arrival.tripId
    );
    if (!entry) return;
    selectedRoute = entry.normalizedRoute;
    selectedTripId = arrival.tripId;
    followingBus = true;
    // Close the stop panel and zoom straight to the bus
    clearSelectedStop();
    map.setView([entry.lat, entry.lng], Math.max(map.getZoom(), 16), {
      animate: true,
    });
    applySearch();
  }

  export function zoomToBus(tripId) {
    const entry = [...busData.values()].find((b) => b.tripId === tripId);
    if (!entry) return;
    selectedRoute = entry.normalizedRoute;
    selectedTripId = tripId;
    if (selectedStop)
      fitBoundsWithPanel(
        L.latLngBounds(
          [entry.lat, entry.lng],
          [+selectedStop.stop_lat, +selectedStop.stop_lon]
        )
      );
    else map.setView([entry.lat, entry.lng], 16);
    applySearch();
  }

  export function jumpToStop(stop) {
    map.setView([+stop.stop_lat, +stop.stop_lon], Math.max(map.getZoom(), 16));
    openStopPanel(stop);
  }

  function locateMe() {
    if (locationMarker) map.setView(locationMarker.getLatLng(), 17);
  }

  function refreshPage() {
    const now = Date.now();
    if (now - lastManualRefresh < 10000) return;
    lastManualRefresh = now;
    refreshBuses(routeNamesGlobal, false);
  }

  function scheduleNextRefresh(routeNames) {
    setTimeout(async () => {
      await refreshBuses(routeNames, true);
      scheduleNextRefresh(routeNames);
    }, backoffDelay);
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

    setInterval(updateTimer, 1000);
    setInterval(() => {
      if (!stopPanelStop || stopPanelLoading) return;
      stopPanelArrivals = stopPanelArrivals.map((a) => ({
        ...a,
        estMinutes: Math.max(0, a.estMinutes - 1 / 60),
      }));
    }, 1000);
    setInterval(async () => {
      if (stopPanelStop && !stopPanelLoading) {
        incomingTripIds = getIncomingTripsForStop(stopPanelStop.stop_id);
        await refreshStopArrivals(stopPanelStop);
        applySearch();
      }
    }, 10000);

    clusterGroup = L.markerClusterGroup({
      disableClusteringAtZoom: 14,
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: false,
      showCoverageOnHover: false,
      iconCreateFunction: (c) =>
        L.divIcon({
          html: `<div class="cluster-icon">${c.getChildCount()}</div>`,
          className: "",
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        }),
    });
    map.addLayer(clusterGroup);
    map.on("moveend zoomend", () => applySearch());
    map.on("click", () => {
      if (stopPanelStop && selectedTripId) {
        selectedRoute = "";
        selectedTripId = "";
        followingBus = false;
        shapeLayerGroup?.clearLayers();
        stopLayerGroup?.clearLayers();
        applySearch();
        const lat = +stopPanelStop.stop_lat,
          lng = +stopPanelStop.stop_lon;
        setTimeout(() => {
          map.setView([lat, lng], Math.max(map.getZoom(), 16), {
            animate: true,
          });
          setTimeout(
            () => map.panBy([0, 160], { animate: true, duration: 0.3 }),
            350
          );
        }, 50);
      } else {
        selectedRoute = "";
        selectedTripId = "";
        followingBus = false;
        clearSelectedStop();
        shapeLayerGroup?.clearLayers();
        stopLayerGroup?.clearLayers();
        applySearch();
      }
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

    const [root, routeNames] = await Promise.all([
      protobuf.load(import.meta.env.BASE_URL + "gtfs-realtime.proto"),
      fetchRouteNames(),
    ]);
    routeNamesGlobal = routeNames;
    FeedMessage = root.lookupType("transit_realtime.FeedMessage");

    await fetchTripRouteNames(routeNames);
    await fetchShapes();
    await refreshBuses(routeNames, false);
    fetchStops().then(() =>
      fetchRouteStops(routeNames).then(() => {
        matchTripsToShapes();
        refilterBusesAfterShapeMatch();
        applySearch();
      })
    );
    scheduleNextRefresh(routeNames);

    if (navigator.geolocation) {
      navigator.geolocation.watchPosition(
        ({ coords: { latitude, longitude } }) => {
          if (locationMarker) locationMarker.setLatLng([latitude, longitude]);
          else {
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
    showBuses;
    savedStops;
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
      src="{import.meta.env.BASE_URL}aoife.png"
      class="spinner"
      alt="loading"
    />
    <span>Loading buses...</span>
  </div>
{/if}

{#if stopPanelStop}
  <div class="stop-panel">
    <div class="stop-panel-header">
      <div class="stop-panel-header-left">
        <div class="stop-panel-code">Stop {stopPanelStop.stop_code}</div>
        <div class="stop-panel-name">{stopPanelStop.stop_name}</div>
      </div>
      <div class="stop-panel-actions">
        <button
          class="save-stop-btn"
          class:saved={isStopSaved(stopPanelStop.stop_id)}
          on:click|stopPropagation={() => toggleSaveStop(stopPanelStop)}
          title={isStopSaved(stopPanelStop.stop_id) ? "Saved" : "Save stop"}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill={isStopSaved(stopPanelStop.stop_id) ? "currentColor" : "none"}
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
            />
          </svg>
        </button>
        <button
          class="stop-panel-close"
          on:click={() => {
            clearSelectedStop();
            applySearch();
          }}>✕</button
        >
      </div>
    </div>
    <div class="stop-panel-board">
      {#if stopPanelLoading}
        <div class="board-empty">Loading arrivals…</div>
      {:else if !stopPanelArrivals.length}
        <div class="board-empty">No upcoming arrivals</div>
      {:else}
        {#each stopPanelArrivals as arrival}
          <button
            class="board-row"
            class:clickable={arrival.type === "live" && arrival.tripId}
            on:click={() => handleArrivalClick(arrival)}
          >
            <span class="board-num">{arrival.routeName}</span>
            <span class="board-dest">
              {arrival.type === "live"
                ? "Live tracking"
                : (arrival.arrivalTime?.slice(0, 5) ?? "—")}
            </span>
            <span
              class="board-time"
              class:board-due={arrival.type === "live" &&
                arrival.estMinutes <= 1}
            >
              {arrival.type === "live"
                ? arrival.estMinutes <= 1
                  ? "Due"
                  : `${Math.floor(arrival.estMinutes)}min`
                : (arrival.arrivalTime?.slice(0, 5) ?? "—")}
            </span>
            {#if arrival.type === "live" && arrival.tripId}
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#e8a020"
                stroke-width="2.5"
                style="flex-shrink:0"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
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
    <line x1="12" x2="12" y1="2" y2="6"></line><line
      x1="12"
      x2="12"
      y1="18"
      y2="22"
    ></line>
    <line x1="2" y1="12" x2="6" y2="12"></line><line
      x1="18"
      y1="12"
      x2="22"
      y2="12"
    ></line>
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
    <polyline points="23 4 23 10 17 10"></polyline><polyline
      points="1 20 1 14 7 14"
    ></polyline>
    <path
      d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"
    ></path>
  </svg>
</button>

{#if timeSinceUpdate}
  <div class="update-pill" class:above-panel={!!stopPanelStop}>
    {timeSinceUpdate}
  </div>
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

  /* ── Stop panel – LED board style ── */
  .stop-panel {
    position: fixed;
    bottom: 100px;
    left: 0;
    right: 0;
    z-index: 1100;
    background: #0e0e0e;
    border-radius: 14px 14px 0 0;
    box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.5);
    max-height: 300px;
    display: flex;
    flex-direction: column;
    font-family: "Courier New", Courier, monospace;
  }
  .stop-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px 8px;
    border-bottom: 1px solid #2a2a2a;
    flex-shrink: 0;
  }
  .stop-panel-header-left {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .stop-panel-code {
    font-size: 10px;
    color: #666;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .stop-panel-name {
    font-size: 13px;
    font-weight: 700;
    color: #e8a020;
    letter-spacing: 0.03em;
  }
  .stop-panel-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .save-stop-btn {
    background: none;
    border: none;
    color: #555;
    cursor: pointer;
    padding: 4px;
    display: flex;
    align-items: center;
    transition: color 0.15s;
  }
  .save-stop-btn.saved {
    color: #e8a020;
  }
  .stop-panel-close {
    background: none;
    border: none;
    font-size: 16px;
    color: #555;
    cursor: pointer;
    padding: 4px 6px;
  }
  .stop-panel-board {
    overflow-y: auto;
    flex: 1;
    padding: 2px 0 6px;
  }
  .board-empty {
    font-size: 12px;
    color: #555;
    padding: 12px 14px;
    font-family: "Courier New", Courier, monospace;
  }
  .board-row {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 7px 14px;
    border-bottom: 1px solid #1a1a1a;
    width: 100%;
    background: none;
    border-left: none;
    border-right: none;
    border-top: none;
    text-align: left;
    cursor: default;
    transition: background 0.1s;
  }
  .board-row.clickable {
    cursor: pointer;
  }
  .board-row.clickable:hover {
    background: #1a1a1a;
  }
  .board-num {
    font-size: 16px;
    font-weight: 700;
    color: #e8a020;
    min-width: 48px;
    letter-spacing: 0.02em;
    font-family: "Courier New", Courier, monospace;
  }
  .board-dest {
    flex: 1;
    font-size: 13px;
    color: #d09010;
    letter-spacing: 0.04em;
    font-family: "Courier New", Courier, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .board-time {
    font-size: 14px;
    font-weight: 700;
    color: #e8a020;
    min-width: 44px;
    text-align: right;
    letter-spacing: 0.02em;
    font-family: "Courier New", Courier, monospace;
    margin-right: 4px;
  }
  .board-time.board-due {
    color: #ff6b35;
    animation: blink 1s step-end infinite;
  }
  @keyframes blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }

  /* ── Bus marker ── */
  :global(.bus-marker-outer) {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    width: 44px;
  }
  :global(.bus-route-label) {
    background: #1a73e8;
    color: white;
    font-size: 11px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 4px;
    white-space: nowrap;
    line-height: 1.4;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    max-width: 44px;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: center;
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
    display: none;
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
  :global(.stop-marker-highlighted) {
    width: 18px;
    height: 18px;
    background: #00e676;
    border: 2px solid white;
    border-radius: 50%;
    box-shadow: 0 0 8px rgba(0, 230, 118, 0.8);
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

  .update-pill {
    position: fixed;
    bottom: 110px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1200;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    font-size: 12px;
    padding: 4px 12px;
    border-radius: 20px;
    pointer-events: none;
    white-space: nowrap;
    transition: bottom 0.2s ease;
  }
  .update-pill.above-panel {
    bottom: 375px;
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
