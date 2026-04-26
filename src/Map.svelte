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
  let followingBus = false;

  let busPanelStops = [];
  let busPanelLoading = false;

  const STOPS_MIN_ZOOM = 14;
  const API = "https://bus-times.ciaranjmcgann.workers.dev";
  const DUBLIN_BOUNDS = {
    minLat: 53.14,
    maxLat: 53.46,
    minLng: -6.63,
    maxLng: -6.0,
  };

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

  function distanceFromShape(tripId, lat, lng) {
    const staticId = resolveStaticTripId(tripId);
    const shapeId = tripShapeMap.get(staticId) || tripShapeMap.get(tripId);
    const pts = shapeId ? shapePoints.get(shapeId) : null;
    if (!pts || pts.length < 2) return 0;
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

  // FIXED: use <= so buses AT the stop index are still shown as incoming
  // Also now scans all busData entries, not just ones already matched
  function getIncomingTripsForStop(stopId) {
    const result = new Set();
    tripStopSequence.forEach((stops, staticTripId) => {
      const targetIdx = stops.findIndex((s) => s.stop_id === stopId);
      if (targetIdx === -1) return;
      busData.forEach((bus) => {
        const resolvedId = resolveStaticTripId(bus.tripId);
        if (resolvedId !== staticTripId) return;
        const i = nearestStopIdx(stops, bus.lat, bus.lng);
        if (i <= targetIdx) result.add(staticTripId);
      });
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

  function clearBusPanel() {
    busPanelStops = [];
    busPanelLoading = false;
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
    const glow = highlighted ? "#00e676" : "#e8a020";
    const rad = (rotation * Math.PI) / 180;
    const dist = 22;
    const dx = Math.sin(rad) * dist;
    const dy = -Math.cos(rad) * dist;

    return L.divIcon({
      className: "",
      html: `<div class="bus-marker-outer" style="opacity:${dimmed ? 0.2 : 1};transition:opacity 0.2s;position:relative;width:20px;height:20px;">
        <div class="bus-marker-wrap" style="
          position:absolute;top:0;left:0;
          transform:${selected || highlighted ? "scale(1.4)" : "scale(1)"};
          filter:${selected || highlighted ? `drop-shadow(0 0 6px ${glow})` : "none"};
          transition:filter 0.2s,transform 0.2s;">
          <img src="${import.meta.env.BASE_URL}dublinbus.png" class="bus-img"
            style="transform:rotate(${rotation - 90}deg) scaleX(-1)${flipped ? " scaleY(-1)" : ""}"/>
        </div>
        <div class="bus-route-label" style="position:absolute;top:50%;left:50%;transform:translate(calc(-50% + ${dx.toFixed(1)}px),calc(-50% + ${dy.toFixed(1)}px));pointer-events:none;">${routeName}</div>
      </div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
      popupAnchor: [0, -20],
    });
  }

  async function loadBusStopPanel(tripId) {
    busPanelLoading = true;
    busPanelStops = [];

    const sid = resolveStaticTripId(tripId);
    let schedule = tripStopSequence.get(sid);

    if (!schedule) {
      const raw = await fetchTripSchedule(sid).catch(() => null);
      if (!raw?.length) {
        busPanelLoading = false;
        return;
      }
      schedule = raw
        .map((s) => ({
          stop_id: s.stop_id,
          seq: +s.stop_sequence,
          arrival_time: s.arrival_time || s.departure_time || null,
        }))
        .sort((a, b) => a.seq - b.seq);
      tripStopSequence.set(sid, schedule);
    }

    const bus = [...busData.values()].find((b) => b.tripId === tripId);
    const nearestIdx = bus ? nearestStopIdx(schedule, bus.lat, bus.lng) : -1;

    const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
    const nearestSched = timeToMins(schedule[nearestIdx]?.arrival_time);
    const drift =
      nearestIdx >= 0 && nearestSched !== null ? nowMins - nearestSched : 0;

    const enriched = schedule.map((s, idx) => {
      const stopInfo = allStops.find((st) => st.stop_id === s.stop_id);
      const scheduledMins = timeToMins(s.arrival_time);
      const isPassed = idx < nearestIdx;
      const isCurrent = idx === nearestIdx;

      let status = "future";
      let displayTime = s.arrival_time?.slice(0, 5) ?? "—";

      if (isPassed || isCurrent) {
        if (Math.abs(drift) <= 1) status = "ontime";
        else if (drift < -1) status = "early";
        else status = "late";
        displayTime = s.arrival_time?.slice(0, 5) ?? "—";
      } else if (scheduledMins !== null) {
        const adjustedMins = scheduledMins + drift;
        const h = Math.floor(adjustedMins / 60) % 24;
        const m = Math.round(adjustedMins % 60);
        displayTime = `${String(h).padStart(2, "0")}:${String(Math.max(0, m)).padStart(2, "0")}`;
        if (Math.abs(drift) <= 1) status = "future";
        else if (drift < -1) status = "future-early";
        else status = "future-late";
      }

      return {
        stop_id: s.stop_id,
        stop_name: stopInfo?.stop_name ?? s.stop_id,
        stop_code: stopInfo?.stop_code ?? "",
        scheduled: s.arrival_time?.slice(0, 5) ?? "—",
        displayTime,
        status,
        isPassed,
        isCurrent,
      };
    });

    busPanelStops = enriched;
    busPanelLoading = false;

    setTimeout(() => {
      document
        .querySelector(".bus-stop-current")
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 100);
  }

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
      if ([idIdx, latIdx, lngIdx, seqIdx].includes(-1)) return;
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
      const liveTripIds = buses.map((b) => b.tripId).filter(Boolean);
      const active = [
        ...new Set(liveTripIds.length ? liveTripIds : [...tripToRoute.keys()]),
      ];
      for (let i = 0; i < active.length; i += 10) {
        await Promise.all(
          active.slice(i, i + 10).map(async (tripId) => {
            const sid = resolveStaticTripId(tripId);
            if (tripStopSequence.has(sid)) return;
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
    } catch {
      console.warn("Could not load route stops");
    }
  }

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
    if (removed > 0) applySearch();
  }

  function refreshAllBearings() {
    busData.forEach((entry) => {
      const bearing = resolveBearing({
        tripId: entry.tripId,
        lat: entry.lat,
        lng: entry.lng,
      });
      entry.bearing = bearing;
      entry.marker.setIcon(
        makeBusIcon(
          bearing,
          false,
          false,
          false,
          getTripDirection(entry.tripId),
          entry.routeName
        )
      );
    });
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

  function renderAllStops() {
    allStopsLayerGroup ||= L.layerGroup().addTo(map);
    allStopsLayerGroup.clearLayers();
    // FIXED: always show stops when zoom is sufficient — don't hide when stop panel is open
    if (!showStops || map.getZoom() < STOPS_MIN_ZOOM) return;
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
      // Skip the selected stop — it has its own highlighted marker
      if (stopPanelStop && stop.stop_id === stopPanelStop.stop_id) continue;
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

    const lineColor = "#e8a020";
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
            html: `<svg width="20" height="20" viewBox="0 0 20 20" style="transform:rotate(${bearing}deg);display:block" xmlns="http://www.w3.org/2000/svg"><polygon points="10,2 17,16 10,12 3,16" fill="${lineColor}" fill-opacity="0.9" stroke="#0e0e0e" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
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
      if (followingBus && !isFollowed) {
        if (clusterGroup.hasLayer(bus.marker))
          clusterGroup.removeLayer(bus.marker);
        return;
      }

      // FIXED: when a stop panel is open, show all buses that pass the
      // favourites/search filter — don't hide non-incoming ones
      const passesFilter = shouldShow(bus.normalizedRoute);
      const visible = showBuses && passesFilter;
      const inViewport = map.getBounds().pad(0.3).contains([bus.lat, bus.lng]);
      const isIncoming = incomingTripIds.has(resolveStaticTripId(bus.tripId));
      const isSelected =
        hasRoute && bus.normalizedRoute === normalize(selectedRoute);

      // Only dim when a specific trip has been tapped from the stop panel
      const dimmed =
        hasStop && selectedTripId ? bus.tripId !== selectedTripId : false;

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

    // CHANGED: zoom to fit all buses of the searched route
    if (shouldAutoFit && visibleMarkers.length) {
      map.fitBounds(L.featureGroup(visibleMarkers).getBounds().pad(0.15), {
        maxZoom: 14,
      });
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
        followingBus = true;
        clearSelectedStop();
        clearBusPanel();
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
        followingBus = false;
        selectedRoute = "";
        selectedTripId = "";
        clearBusPanel();
        shapeLayerGroup?.clearLayers();
        stopLayerGroup?.clearLayers();
        applySearch();
        return;
      }

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
      loadBusStopPanel(bus.tripId);
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
        const nr = normalize(newBus.routeName);
        const bearing = resolveBearing(newBus);
        const distFromRoute = distanceFromShape(
          newBus.tripId,
          newBus.lat,
          newBus.lng
        );
        if (distFromRoute > 0.001) {
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
      if (selectedTripId && busPanelStops.length) {
        loadBusStopPanel(selectedTripId);
      }
      updateTimer();
      applySearch();
    } finally {
      isFetching = false;
    }
  }

  // FIXED: eagerly fetch all live bus schedules before computing arrivals
  // so we don't miss buses whose trip schedules haven't loaded yet
  async function refreshStopArrivals(stop) {
    const unfetched = [
      ...new Set(
        [...busData.values()]
          .map((b) => resolveStaticTripId(b.tripId))
          .filter((sid) => sid && !tripStopSequence.has(sid))
      ),
    ];

    if (unfetched.length > 0) {
      await Promise.all(
        unfetched.map(async (sid) => {
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
    }

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
      // FIXED: <= so bus sitting at the stop is included
      if (i > targetIdx) return;
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
      stopPanelArrivals = trips.slice(0, 12);
      return;
    }

    // Fallback to scheduled
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
        .slice(0, 12)
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
    clearBusPanel();

    const lat = +stop.stop_lat,
      lng = +stop.stop_lon;
    setTimeout(() => {
      map.setView([lat, lng], Math.max(map.getZoom(), 16), { animate: true });
      setTimeout(
        () => map.panBy([0, 100], { animate: true, duration: 0.3 }),
        350
      );
    }, 50);
    applySearch();

    try {
      // Eagerly fetch all live bus schedules so arrivals are complete
      const unfetched = [
        ...new Set(
          [...busData.values()]
            .map((b) => resolveStaticTripId(b.tripId))
            .filter((sid) => sid && !tripStopSequence.has(sid))
        ),
      ];

      await Promise.all(
        unfetched.map(async (sid) => {
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
    followingBus = false;
    loadBusStopPanel(arrival.tripId);

    const stopLat = +stopPanelStop.stop_lat;
    const stopLng = +stopPanelStop.stop_lon;
    const latDiff = Math.abs(entry.lat - stopLat);
    const lngDiff = Math.abs(entry.lng - stopLng);
    const radius = Math.max(latDiff, lngDiff * 0.6, 0.004) * 1.6;

    map.fitBounds(
      [
        [stopLat - radius, stopLng - radius / 0.6],
        [stopLat + radius, stopLng + radius / 0.6],
      ],
      {
        paddingTopLeft: [60, 60],
        paddingBottomRight: [60, 320],
        animate: true,
        duration: 0.6,
      }
    );
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
      zoomControl: false,
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
      // Dispatch clearSearch so App.svelte resets the SearchBox value
      dispatch("clearSearch");
      if (stopPanelStop && selectedTripId) {
        selectedRoute = "";
        selectedTripId = "";
        followingBus = false;
        clearBusPanel();
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
            () => map.panBy([0, 100], { animate: true, duration: 0.3 }),
            350
          );
        }, 50);
      } else {
        selectedRoute = "";
        selectedTripId = "";
        followingBus = false;
        clearBusPanel();
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
        refreshAllBearings();
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
              radius: 8,
              fillColor: "#e8a020",
              color: "#0e0e0e",
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

  // CHANGED: trigger auto-fit zoom when searchTerm changes to a valid route
  let prevSearchTerm = "";
  let searchDebounce;
  $: {
    if (searchTerm !== prevSearchTerm) {
      prevSearchTerm = searchTerm;
      if (searchTerm) shouldAutoFit = true;
    }
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
    <span class="loading-text">Loading buses...</span>
  </div>
{/if}

<!-- Update pill — moved to TOP, below search bar -->
{#if timeSinceUpdate}
  <div class="update-pill">{timeSinceUpdate}</div>
{/if}

<!-- Stop arrivals panel — floats above footer -->
{#if stopPanelStop}
  <div class="board-panel">
    <div class="board-panel-header">
      <div class="board-panel-header-left">
        <div class="board-stop-code">STOP {stopPanelStop.stop_code}</div>
        <div class="board-stop-name">{stopPanelStop.stop_name}</div>
      </div>
      <div class="board-panel-actions">
        <button
          class="board-icon-btn"
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
          class="board-icon-btn board-close-btn"
          on:click={() => {
            clearSelectedStop();
            applySearch();
          }}>✕</button
        >
      </div>
    </div>
    <div class="board-rows">
      {#if stopPanelLoading}
        <div class="board-empty">Loading arrivals…</div>
      {:else if !stopPanelArrivals.length}
        <div class="board-empty">No upcoming arrivals</div>
      {:else}
        {#each stopPanelArrivals as arrival}
          <button
            class="board-row"
            class:board-row-live={arrival.type === "live" && arrival.tripId}
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

<!-- Bus stop times panel — stacks above stop panel when both open -->
{#if selectedTripId && busPanelStops.length > 0}
  <div
    class="board-panel bus-stop-panel"
    class:with-stop-panel={!!stopPanelStop}
  >
    <div class="board-panel-header">
      <div class="board-panel-header-left">
        <div class="board-stop-code">ROUTE</div>
        <div class="board-stop-name">
          {[...busData.values()].find((b) => b.tripId === selectedTripId)
            ?.routeName ?? ""}
        </div>
      </div>
      <button
        class="board-icon-btn board-close-btn"
        on:click={() => {
          selectedRoute = "";
          selectedTripId = "";
          followingBus = false;
          clearBusPanel();
          shapeLayerGroup?.clearLayers();
          stopLayerGroup?.clearLayers();
          applySearch();
        }}>✕</button
      >
    </div>
    <div class="board-rows bus-stop-list">
      {#if busPanelLoading}
        <div class="board-empty">Loading stops…</div>
      {:else}
        {#each busPanelStops as stop}
          <div
            class="bus-stop-row"
            class:bus-stop-passed={stop.isPassed}
            class:bus-stop-current={stop.isCurrent}
          >
            <div class="bs-spine">
              <div
                class="bs-line bs-line-top"
                class:bs-line-filled={stop.isPassed || stop.isCurrent}
              ></div>
              <div
                class="bs-dot"
                class:bs-dot-current={stop.isCurrent}
                class:bs-dot-passed={stop.isPassed}
              ></div>
              <div
                class="bs-line bs-line-bot"
                class:bs-line-filled={stop.isPassed}
              ></div>
            </div>
            <div class="bs-info">
              <span class="bs-name" class:bs-name-passed={stop.isPassed}
                >{stop.stop_name}</span
              >
              {#if stop.stop_code}<span class="bs-code">{stop.stop_code}</span
                >{/if}
            </div>
            <div
              class="bs-time"
              class:bs-ontime={stop.status === "ontime"}
              class:bs-early={stop.status === "early"}
              class:bs-late={stop.status === "late"}
              class:bs-future={stop.status === "future"}
              class:bs-future-early={stop.status === "future-early"}
              class:bs-future-late={stop.status === "future-late"}
            >
              {stop.displayTime}
              {#if stop.status === "early" || stop.status === "future-early"}
                <span class="bs-badge bs-badge-early">early</span>
              {:else if stop.status === "late" || stop.status === "future-late"}
                <span class="bs-badge bs-badge-late">late</span>
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<!-- Map controls — all on LEFT side -->
<div class="map-controls-left">
  <button class="map-btn" on:click={locateMe} title="My location">
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <circle cx="12" cy="12" r="8" />
      <line x1="12" x2="12" y1="2" y2="6" /><line
        x1="12"
        x2="12"
        y1="18"
        y2="22"
      />
      <line x1="2" y1="12" x2="6" y2="12" /><line
        x1="18"
        y1="12"
        x2="22"
        y2="12"
      />
    </svg>
  </button>
  <button class="map-btn" on:click={refreshPage} title="Refresh">
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
      <path
        d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"
      />
    </svg>
  </button>
  <button class="map-btn" on:click={() => map.zoomIn()} title="Zoom in">
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <line x1="12" y1="5" x2="12" y2="19" /><line
        x1="5"
        y1="12"
        x2="19"
        y2="12"
      />
    </svg>
  </button>
  <button class="map-btn" on:click={() => map.zoomOut()} title="Zoom out">
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  </button>
</div>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100%;
    overflow: hidden;
    touch-action: pan-x pan-y;
    background: #0e0e0e;
  }
  .map {
    width: 100%;
    height: 100%;
  }

  /* ── Shared panel base ── */
  .board-panel {
    position: fixed;
    bottom: 100px; /* always above the 100px footer */
    left: 0;
    right: 0;
    z-index: 1100;
    background: #0e0e0e;
    border-top: 1px solid #2a2a2a;
    border-radius: 14px 14px 0 0;
    box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.7);
    max-height: 260px;
    display: flex;
    flex-direction: column;
    font-family: "Courier New", Courier, monospace;
  }

  /* Bus stop panel: default above footer, shifts up when stop panel also open */
  .bus-stop-panel {
    bottom: 100px;
  }
  .bus-stop-panel.with-stop-panel {
    bottom: 200px; /* 100px footer + 260px stop panel + 10px gap */
  }

  .board-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px 10px;
    border-bottom: 1px solid #1e1e1e;
    flex-shrink: 0;
  }
  .board-panel-header-left {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .board-stop-code {
    font-size: 10px;
    color: #555;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-family: "Courier New", Courier, monospace;
  }
  .board-stop-name {
    font-size: 15px;
    font-weight: 700;
    color: #e8a020;
    letter-spacing: 0.04em;
    font-family: "Courier New", Courier, monospace;
  }
  .board-panel-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .board-icon-btn {
    background: none;
    border: none;
    color: #555;
    cursor: pointer;
    padding: 6px;
    display: flex;
    align-items: center;
    border-radius: 6px;
    transition:
      color 0.15s,
      background 0.15s;
    font-family: "Courier New", Courier, monospace;
  }
  .board-icon-btn:hover {
    color: #e8a020;
    background: #1a1a1a;
  }
  .board-icon-btn.saved {
    color: #e8a020;
  }
  .board-close-btn {
    font-size: 15px;
    color: #444;
  }
  .board-close-btn:hover {
    color: #e8a020;
  }

  .board-rows {
    overflow-y: auto;
    flex: 1;
    padding: 2px 0 8px;
  }
  .board-empty {
    font-size: 12px;
    color: #444;
    padding: 14px 16px;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.05em;
  }
  .board-row {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 9px 16px;
    border-bottom: 1px solid #161616;
    width: 100%;
    background: none;
    border-left: none;
    border-right: none;
    border-top: none;
    text-align: left;
    cursor: default;
    transition: background 0.1s;
  }
  .board-row-live {
    cursor: pointer;
  }
  .board-row-live:active {
    background: #1a1a1a;
  }
  .board-num {
    font-size: 18px;
    font-weight: 700;
    color: #e8a020;
    min-width: 52px;
    letter-spacing: 0.02em;
    font-family: "Courier New", Courier, monospace;
  }
  .board-dest {
    flex: 1;
    font-size: 13px;
    color: #a06a10;
    letter-spacing: 0.04em;
    font-family: "Courier New", Courier, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .board-time {
    font-size: 15px;
    font-weight: 700;
    color: #e8a020;
    min-width: 52px;
    text-align: right;
    letter-spacing: 0.02em;
    font-family: "Courier New", Courier, monospace;
    margin-right: 4px;
  }
  .board-due {
    color: #ff6b35;
    animation: blink 1s step-end infinite;
  }
  @keyframes blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.25;
    }
  }

  /* ── Bus stop list ── */
  .bus-stop-list {
    padding: 0;
  }
  .bus-stop-row {
    display: flex;
    align-items: stretch;
    gap: 10px;
    padding: 0 16px;
    min-height: 40px;
  }
  .bus-stop-current {
    background: #111008;
  }

  .bs-spine {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 14px;
    flex-shrink: 0;
  }
  .bs-line {
    width: 2px;
    flex: 1;
    background: #1e1e1e;
    min-height: 6px;
  }
  .bs-line-filled {
    background: #3a2e00;
  }
  .bs-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #222;
    border: 2px solid #333;
    flex-shrink: 0;
    z-index: 1;
    transition: all 0.2s;
  }
  .bs-dot-passed {
    background: #3a2e00;
    border-color: #6a5000;
  }
  .bs-dot-current {
    width: 12px;
    height: 12px;
    background: #e8a020;
    border-color: #e8a020;
    box-shadow: 0 0 6px rgba(232, 160, 32, 0.6);
  }

  .bs-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    padding: 4px 0;
  }
  .bs-name {
    font-size: 12px;
    color: #e8a020;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.02em;
  }
  .bs-name-passed {
    color: #4a3800;
  }
  .bs-code {
    font-size: 10px;
    color: #3a3000;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.05em;
  }
  .bus-stop-current .bs-name {
    color: #e8a020;
  }
  .bus-stop-current .bs-code {
    color: #6a5010;
  }

  .bs-time {
    font-size: 12px;
    font-weight: 700;
    font-family: "Courier New", Courier, monospace;
    min-width: 48px;
    text-align: right;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    padding: 4px 0;
    letter-spacing: 0.03em;
  }
  .bs-ontime {
    color: #1a1a1a;
  }
  .bs-early {
    color: #2a7a2a;
  }
  .bs-late {
    color: #8a2a2a;
  }
  .bs-future {
    color: #6a5010;
  }
  .bs-future-early {
    color: #2a6a2a;
  }
  .bs-future-late {
    color: #7a2a2a;
  }
  .bus-stop-current .bs-time {
    color: #e8a020;
  }

  .bs-badge {
    font-size: 9px;
    padding: 1px 3px;
    border-radius: 3px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .bs-badge-early {
    background: #0a2a0a;
    color: #2a8a2a;
    border: 1px solid #1a4a1a;
  }
  .bs-badge-late {
    background: #2a0a0a;
    color: #aa3a3a;
    border: 1px solid #4a1a1a;
  }

  /* ── Map controls on LEFT ── */
  .map-controls-left {
    position: fixed;
    left: 12px;
    top: 12px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .map-btn {
    width: 44px;
    height: 44px;
    background: #0e0e0e;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    color: #e8a020;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition:
      background 0.15s,
      border-color 0.15s;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    padding: 0;
  }
  .map-btn:hover {
    background: #1a1a1a;
    border-color: #e8a020;
  }
  .map-btn:active {
    background: #2a2000;
  }

  /* ── Bus marker ── */
  :global(.bus-marker-outer) {
    position: relative;
    width: 20px;
    height: 20px;
  }
  :global(.bus-marker-wrap) {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  :global(.bus-img) {
    width: 20px;
    height: 20px;
    object-fit: contain;
  }
  :global(.bus-route-label) {
    background: #0e0e0e;
    color: #e8a020;
    font-family: "Courier New", Courier, monospace;
    font-size: 10px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid #2a2a2a;
    white-space: nowrap;
    line-height: 1.4;
    letter-spacing: 0.05em;
    text-align: center;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
  }

  /* ── Cluster ── */
  :global(.cluster-icon) {
    width: 34px;
    height: 34px;
    background: #0e0e0e;
    color: #e8a020;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    border: 2px solid #e8a020;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.02em;
  }

  /* ── Stop markers ── */
  :global(.stop-marker) {
    width: 10px;
    height: 10px;
    background: #0e0e0e;
    border: 2px solid #e8a020;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
    opacity: 0.7;
  }
  :global(.stop-marker-highlighted) {
    width: 16px;
    height: 16px;
    background: #2a8a2a;
    border: 2px solid #0e0e0e;
    border-radius: 50%;
    box-shadow: 0 0 8px rgba(232, 160, 32, 0.7);
  }

  /* ── Update pill — TOP below search ── */
  .update-pill {
    position: fixed;
    top: 66px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    background: #0e0e0e;
    border: 1px solid #2a2a2a;
    color: #555;
    font-size: 11px;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.06em;
    padding: 4px 14px;
    border-radius: 20px;
    pointer-events: none;
    white-space: nowrap;
  }

  /* ── Loading ── */
  .loading {
    position: fixed;
    inset: 0;
    z-index: 2000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #0e0e0e;
    gap: 14px;
  }
  .loading-text {
    font-family: "Courier New", Courier, monospace;
    color: #e8a020;
    font-size: 13px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
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

  /* ── Leaflet overrides ── */
  :global(.leaflet-control-zoom) {
    display: none;
  }
  :global(.leaflet-control-attribution) {
    background: rgba(14, 14, 14, 0.7) !important;
    color: #333 !important;
    font-size: 9px !important;
    border-radius: 4px 0 0 0 !important;
  }
  :global(.leaflet-control-attribution a) {
    color: #555 !important;
  }
  :global(.leaflet-popup-content-wrapper) {
    background: #0e0e0e !important;
    border: 1px solid #2a2a2a !important;
    color: #e8a020 !important;
    font-family: "Courier New", Courier, monospace !important;
    border-radius: 8px !important;
  }
  :global(.leaflet-popup-tip) {
    background: #0e0e0e !important;
  }
</style>
