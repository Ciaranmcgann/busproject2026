<script>
  import Map from "./Map.svelte";
  import SearchBox from "./SearchBox.svelte";
  import { onMount } from "svelte";

  let searchTerm = "";
  let routes = [];

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

  onMount(loadRoutes);
</script>

<div class="app">
  <SearchBox on:search={handleSearch} {routes} />

  <main>
    <Map {searchTerm} />
  </main>
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
