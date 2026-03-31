<script>
  import Map from "./Map.svelte";
  import SearchBox from "./SearchBox.svelte";
  import Favourites from "./Favouritesfooter.svelte";
  import { onMount } from "svelte";

  let searchTerm = "";
  let routes = [];

  // ⭐ favourites state
  let favourites = [];
  let favouritesMode = false;

  function handleSearch(event) {
    searchTerm = event.detail;
  }

  async function loadRoutes() {
    try {
      const res = await fetch(
        "https://bus-times.ciaranjmcgann.workers.dev/routes"
      );
      const data = await res.json();

      routes = data.map((r) => r.route_short_name).filter(Boolean);
    } catch (err) {
      console.error(err);
    }
  }

  // ⭐ toggle favourite
  function toggleFavourite(route) {
    const normalized = route.toLowerCase().replace(/\s/g, "");

    if (favourites.includes(normalized)) {
      favourites = favourites.filter((f) => f !== normalized);
    } else {
      favourites = [...favourites, normalized];
    }
  }

  // ⭐ toggle favourites mode
  function toggleMode() {
    favouritesMode = !favouritesMode;
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

  <!-- ⭐ Footer -->
  <Favourites
    {favourites}
    {favouritesMode}
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
