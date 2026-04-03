<script>
  import Map from "./Map.svelte";
  import SearchBox from "./SearchBox.svelte";
  import Favourites from "./Favouritesfooter.svelte";
  import { onMount } from "svelte";

  let searchTerm = "";
  let routes = [];

  // Load favourites from localStorage on startup
  let favourites = JSON.parse(localStorage.getItem("bus-favourites") || "[]");
  let favouritesMode = localStorage.getItem("bus-favourites-mode") === "true";

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
    // Save to localStorage whenever it changes
    localStorage.setItem("bus-favourites", JSON.stringify(favourites));
  }

  function toggleMode() {
    favouritesMode = !favouritesMode;
    localStorage.setItem("bus-favourites-mode", favouritesMode);
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
      on:addFavourite={(e) => toggleFavourite(e.detail)}
    />
  </main>

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
</style>
