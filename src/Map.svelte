<script>
  import { onMount } from "svelte";
  import L from "leaflet";
  import protobuf from "protobufjs";

  let map;

  async function fetchBuses() {
    const root = await protobuf.load("/gtfs-realtime.txt");
    const FeedMessage = root.lookupType("transit_realtime.FeedMessage");

    const res = await fetch(
      "https://bus-times.ciaranjmcgann.workers.dev/vehicles"
    );
    const buffer = await res.arrayBuffer();

    const feed = FeedMessage.decode(new Uint8Array(buffer));

    return feed.entity
      .map((e) => e.vehicle)
      .filter((v) => v && v.position)
      .map((v) => ({
        route: v.trip?.routeId || "N/A",
        lat: v.position.latitude,
        lng: v.position.longitude,
      }));
  }

  onMount(async () => {
    map = L.map("map").setView([53.35, -6.26], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(
      map
    );

    const buses = await fetchBuses();
    buses.forEach((bus) => {
      L.marker([bus.lat, bus.lng]).addTo(map).bindPopup(`Route ${bus.route}`);
    });
  });
</script>

<div id="map" style="height: 600px; width: 100%;"></div>
