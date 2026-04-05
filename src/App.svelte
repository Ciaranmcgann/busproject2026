<script>
  import Map from "./Map.svelte";
  import SearchBox from "./SearchBox.svelte";
  import Favourites from "./Favouritesfooter.svelte";
  import { onMount } from "svelte";

  let searchTerm = "";
  let routes = [];
  let mapRef;
  let favouritesRef;
  let allStops = [];

  let favourites = JSON.parse(localStorage.getItem("bus-favourites") || "[]");
  let favouritesMode = localStorage.getItem("bus-favourites-mode") === "true";
  let showStops = false;
  let showBuses = true;

  // Single source of truth for saved stops — shared between Map panel and footer
  let savedStops = JSON.parse(localStorage.getItem("bus-saved-stops") || "[]");

  function handleSearch(event) {
    searchTerm = event.detail;
  }

  function handleStopsLoaded(e) {
    allStops = e.detail;
  }

  async function loadRoutes() {
    try {
      const res = await fetch(
        "https://bus-times.ciaranjmcgann.workers.dev/routes"
      );
      const data = await res.json();
      routes = [
        ...new Set(data.map((r) => r.route_short_name).filter(Boolean)),
      ].sort();
    } catch (err) {
      console.error(err);
    }
  }

  function toggleFavourite(route) {
    const normalized = route.toLowerCase().replace(/\s/g, "");
    if (favourites.includes(normalized)) {
      favourites = favourites.filter((f) => f !== normalized);
    } else {
      favourites = [...favourites, normalized];
    }
    localStorage.setItem("bus-favourites", JSON.stringify(favourites));
  }

  function toggleMode() {
    favouritesMode = !favouritesMode;
    localStorage.setItem("bus-favourites-mode", favouritesMode);
  }

  function toggleStops() {
    showStops = !showStops;
  }

  function toggleBuses() {
    showBuses = !showBuses;
  }

  function handleJumpToStop(e) {
    mapRef?.jumpToStop(e.detail);
  }

  // Both the map panel Save button and the footer search use this
  function handleToggleSavedStop(e) {
    const stop = e.detail;
    const exists = savedStops.some((s) => s.stop_id === stop.stop_id);
    if (exists) {
      savedStops = savedStops.filter((s) => s.stop_id !== stop.stop_id);
    } else {
      savedStops = [
        ...savedStops,
        {
          stop_id: stop.stop_id,
          stop_name: stop.stop_name,
          stop_code: stop.stop_code,
          stop_lat: stop.stop_lat,
          stop_lon: stop.stop_lon,
        },
      ];
    }
    localStorage.setItem("bus-saved-stops", JSON.stringify(savedStops));
  }

  onMount(loadRoutes);
</script>

<div class="app">
  <SearchBox on:search={handleSearch} {routes} />

  <main>
    <Map
      bind:this={mapRef}
      {searchTerm}
      {favourites}
      {favouritesMode}
      {showStops}
      {showBuses}
      {savedStops}
      on:addFavourite={(e) => toggleFavourite(e.detail)}
      on:stopsLoaded={handleStopsLoaded}
      on:toggleSavedStop={handleToggleSavedStop}
    />
  </main>

  <button
    class="stops-btn"
    class:active={showStops}
    on:click={toggleStops}
    title="Toggle stops"
  >
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <circle cx="12" cy="12" r="4"></circle>
      <circle cx="12" cy="12" r="9" stroke-dasharray="3 3"></circle>
    </svg>
  </button>

  <button
    class="buses-btn"
    class:active={showBuses}
    on:click={toggleBuses}
    title="Toggle buses"
  >
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <rect x="1" y="3" width="15" height="13" rx="2"></rect>
      <path d="M16 8h4l3 5v3h-7V8z"></path>
      <circle cx="5.5" cy="18.5" r="2.5"></circle>
      <circle cx="18.5" cy="18.5" r="2.5"></circle>
    </svg>
  </button>

  <Favourites
    bind:this={favouritesRef}
    {favourites}
    {favouritesMode}
    allRoutes={routes}
    {allStops}
    {savedStops}
    on:toggleFavourite={(e) => toggleFavourite(e.detail)}
    on:toggleMode={toggleMode}
    on:jumpToStop={handleJumpToStop}
    on:toggleSavedStop={handleToggleSavedStop}
  />
</div>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100%;
    overflow: hidden;
  }

  .app {
    height: 100vh;
    position: relative;
  }

  main {
    height: 100%;
  }

  .stops-btn,
  .buses-btn {
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
    transition:
      background 0.2s,
      color 0.2s;
  }

  .stops-btn {
    top: 190px;
  }
  .buses-btn {
    top: 250px;
  }

  .stops-btn.active,
  .buses-btn.active {
    background: #1a73e8;
    color: white;
  }
</style>
