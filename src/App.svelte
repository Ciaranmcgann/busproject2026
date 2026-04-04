<script>
  import Map from "./Map.svelte";
  import SearchBox from "./SearchBox.svelte";
  import Favourites from "./Favouritesfooter.svelte";
  import { onMount } from "svelte";

  let searchTerm = "";
  let routes = [];

  let favourites = JSON.parse(localStorage.getItem("bus-favourites") || "[]");
  let favouritesMode = localStorage.getItem("bus-favourites-mode") === "true";
  let showStops = false;

  function handleSearch(event) {
    searchTerm = event.detail;
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

  onMount(loadRoutes);
</script>

<div class="app">
  <SearchBox on:search={handleSearch} {routes} />

  <main>
    <Map
      {searchTerm}
      {favourites}
      {favouritesMode}
      {showStops}
      on:addFavourite={(e) => toggleFavourite(e.detail)}
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

  <Favourites
    {favourites}
    {favouritesMode}
    allRoutes={routes}
    on:toggleFavourite={(e) => toggleFavourite(e.detail)}
    on:toggleMode={toggleMode}
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

  .stops-btn {
    position: fixed;
    right: 10px;
    top: 190px;
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

  .stops-btn.active {
    background: #1a73e8;
    color: white;
  }
</style>
