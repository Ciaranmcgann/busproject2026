<script>
  import Map from "./Map.svelte";
</script>

<main>
  <Map />
</main>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100%;
  }

  main {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }
</style>
