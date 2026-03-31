<script>
  import { createEventDispatcher } from "svelte";

  const dispatch = createEventDispatcher();

  let value = "";
  let suggestions = [];

  // Example static fallback (optional UX improvement)
  // You can replace this later with API suggestions
  let allRoutes = [];

  // Receive routes from parent if you want later
  export let routes = [];

  $: allRoutes = routes;

  function normalize(str) {
    return str.replace(/\s/g, "").toLowerCase();
  }

  function handleInput() {
    const term = normalize(value);

    dispatch("search", value);

    if (!term) {
      suggestions = [];
      return;
    }

    suggestions = allRoutes
      .filter((r) => normalize(r).startsWith(term))
      .slice(0, 8);
  }

  function selectSuggestion(s) {
    value = s;
    suggestions = [];
    dispatch("search", s);
  }

  function handleKeydown(event) {
    if (event.key === "Enter" && suggestions.length > 0) {
      selectSuggestion(suggestions[0]);
    }
  }
</script>

<div class="search-container">
  <input
    type="text"
    placeholder="Search bus route (e.g. 15A)"
    bind:value
    on:input={handleInput}
    on:keydown={handleKeydown}
  />

  {#if suggestions.length > 0}
    <ul class="dropdown">
      {#each suggestions as s}
        <li on:click={() => selectSuggestion(s)}>
          {s}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .search-container {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    width: 280px;
  }

  input {
    width: 80%;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid #ccc;
    font-size: 14px;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
  }

  .dropdown {
    margin-top: 6px;
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    max-height: 200px;
    overflow-y: auto;
    padding: 0;
    list-style: none;
  }

  .dropdown li {
    padding: 10px;
    cursor: pointer;
  }

  .dropdown li:hover {
    background: #f0f0f0;
  }
</style>
