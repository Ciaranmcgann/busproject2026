<script>
  import { createEventDispatcher } from "svelte";

  const dispatch = createEventDispatcher();

  export let favourites = [];
  export let favouritesMode = false;
  export let allRoutes = [];
  export let allStops = [];
  export let savedStops = []; // single source of truth from App.svelte

  let pageOpen = false;
  let editMode = false;
  let searchTerm = "";
  let searchResults = [];

  let activeTab = "routes";
  let stopSearchTerm = "";
  let stopSearchResults = [];

  function toggleFavourite(route) {
    dispatch("toggleFavourite", route);
  }

  function toggleMode() {
    dispatch("toggleMode");
  }

  function toggleSavedStop(stop) {
    dispatch("toggleSavedStop", stop);
  }

  function isSavedStop(stop_id) {
    return savedStops.some((s) => s.stop_id === stop_id);
  }

  function openPage(tab = "routes") {
    pageOpen = true;
    activeTab = tab;
    editMode = false;
    searchTerm = "";
    searchResults = [];
    stopSearchTerm = "";
    stopSearchResults = [];
  }

  function closePage() {
    pageOpen = false;
    editMode = false;
    searchTerm = "";
    searchResults = [];
    stopSearchTerm = "";
    stopSearchResults = [];
  }

  function normalize(str) {
    return (str || "").replace(/\s/g, "").toLowerCase();
  }

  function handleSearch(e) {
    searchTerm = e.target.value;
    const term = normalize(searchTerm);
    if (!term) {
      searchResults = [];
      return;
    }
    searchResults = allRoutes
      .filter((r) => normalize(r).startsWith(term))
      .slice(0, 10);
  }

  function addFavourite(route) {
    if (!favourites.includes(normalize(route))) {
      dispatch("toggleFavourite", route);
    }
    searchTerm = "";
    searchResults = [];
  }

  function handleStopSearch(e) {
    stopSearchTerm = e.target.value;
    const term = normalize(stopSearchTerm);
    if (!term) {
      stopSearchResults = [];
      return;
    }
    stopSearchResults = allStops
      .filter(
        (s) =>
          normalize(s.stop_name).includes(term) ||
          (s.stop_code && normalize(s.stop_code).includes(term))
      )
      .slice(0, 10);
  }

  function tapSavedStop(stop) {
    dispatch("jumpToStop", stop);
    closePage();
  }
</script>

<div class="footer">
  <button class="fav-open-btn" on:click={() => openPage("routes")}>
    <span class="label">Saved Routes</span>
    {#if favourites.length > 0}
      <span class="badge">{favourites.length}</span>
    {/if}
  </button>

  <button class="fav-open-btn" on:click={() => openPage("stops")}>
    <span class="label">Saved Stops</span>
    {#if savedStops.length > 0}
      <span class="badge">{savedStops.length}</span>
    {/if}
  </button>

  <button
    class="mode-btn"
    class:active={favouritesMode}
    on:click={toggleMode}
    title={favouritesMode ? "Showing favourites only" : "Showing all buses"}
  >
    {favouritesMode ? "★" : "☆"}
  </button>
</div>

{#if pageOpen}
  <div class="fav-page">
    <div class="fav-page-header">
      <button class="back-btn" on:click={closePage}>← Back</button>
      <div class="tab-switcher">
        <button
          class="tab-btn"
          class:active={activeTab === "routes"}
          on:click={() => (activeTab = "routes")}
        >
          Routes
        </button>
        <button
          class="tab-btn"
          class:active={activeTab === "stops"}
          on:click={() => (activeTab = "stops")}
        >
          Stops
        </button>
      </div>
      <button
        class="edit-btn"
        class:active={editMode}
        on:click={() => (editMode = !editMode)}
      >
        {editMode ? "Done" : "Edit"}
      </button>
    </div>

    {#if activeTab === "routes"}
      <div class="search-wrap">
        <input
          class="search-input"
          type="text"
          placeholder="Search routes to add..."
          value={searchTerm}
          on:input={handleSearch}
        />
        {#if searchResults.length > 0}
          <div class="search-results">
            {#each searchResults as result}
              <button
                class="search-result-item"
                class:already={favourites.includes(normalize(result))}
                on:click={() => addFavourite(result)}
              >
                <span>{result}</span>
                <span class="add-icon"
                  >{favourites.includes(normalize(result)) ? "✓" : "+"}</span
                >
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <div class="fav-list">
        {#if favourites.length === 0}
          <div class="empty">
            <div class="empty-icon">☆</div>
            <div>No favourite routes yet</div>
            <div class="empty-sub">Search for a route above to add one</div>
          </div>
        {:else}
          {#each favourites as fav}
            <div class="fav-row">
              <div class="fav-route-pill">{fav}</div>
              {#if editMode}
                <button class="remove-btn" on:click={() => toggleFavourite(fav)}
                  >Remove</button
                >
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    {:else}
      <div class="search-wrap">
        <input
          class="search-input"
          type="text"
          placeholder="Search by stop name or number..."
          value={stopSearchTerm}
          on:input={handleStopSearch}
        />
        {#if stopSearchResults.length > 0}
          <div class="search-results">
            {#each stopSearchResults as stop}
              <button
                class="search-result-item"
                class:already={isSavedStop(stop.stop_id)}
                on:click={() => toggleSavedStop(stop)}
              >
                <span>
                  <span class="stop-result-name">{stop.stop_name}</span>
                  <span class="stop-result-code">#{stop.stop_code}</span>
                </span>
                <span class="add-icon"
                  >{isSavedStop(stop.stop_id) ? "✓" : "+"}</span
                >
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <div class="fav-list">
        {#if savedStops.length === 0}
          <div class="empty">
            <div class="empty-icon">🚏</div>
            <div>No saved stops yet</div>
            <div class="empty-sub">
              Search for a stop above, or tap a stop on the map and press Save
              stop
            </div>
          </div>
        {:else}
          {#each savedStops as stop}
            <div
              class="fav-row"
              style="cursor:pointer;"
              on:click={() => tapSavedStop(stop)}
            >
              <div>
                <div class="fav-route-pill">{stop.stop_name}</div>
                <div class="stop-code-label">Stop #{stop.stop_code}</div>
              </div>
              {#if editMode}
                <button
                  class="remove-btn"
                  on:click|stopPropagation={() => toggleSavedStop(stop)}
                >
                  Remove
                </button>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .footer {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 100px;
    background: #0e0e0e;
    border-top: 1px solid #2a2a2a;
    z-index: 1000;
    display: flex;
    align-items: center;
    padding: 0 12px;
    padding-bottom: env(safe-area-inset-bottom);
    gap: 8px;
    box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.7);
  }

  .fav-open-btn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    background: #0e0e0e;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    padding: 20px 14px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 700;
    color: #e8a020;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    transition:
      background 0.15s,
      border-color 0.15s;
  }

  .fav-open-btn:hover {
    background: #1a1a1a;
    border-color: #e8a020;
  }

  .label {
    flex: 1;
    text-align: left;
  }

  .badge {
    background: #e8a020;
    color: #0e0e0e;
    font-size: 11px;
    font-weight: 700;
    border-radius: 10px;
    padding: 2px 7px;
    min-width: 20px;
    text-align: center;
    font-family: "Courier New", Courier, monospace;
  }

  .mode-btn {
    width: 40px;
    height: 40px;
    border-radius: 8px;
    border: 1px solid #2a2a2a;
    background: #0e0e0e;
    color: #e8a020;
    font-size: 20px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition:
      background 0.15s,
      border-color 0.15s;
    flex-shrink: 0;
  }

  .mode-btn.active {
    background: #2a2000;
    border-color: #e8a020;
  }

  /* ── Full-screen page ── */
  .fav-page {
    position: fixed;
    inset: 0;
    background: #0e0e0e;
    z-index: 2000;
    display: flex;
    flex-direction: column;
    font-family: "Courier New", Courier, monospace;
  }

  .fav-page-header {
    display: flex;
    align-items: center;
    padding: 16px;
    background: #0e0e0e;
    border-bottom: 1px solid #2a2a2a;
    gap: 12px;
  }

  .tab-switcher {
    flex: 1;
    display: flex;
    justify-content: center;
    gap: 6px;
  }

  .tab-btn {
    background: #0e0e0e;
    border: 1px solid #2a2a2a;
    border-radius: 6px;
    padding: 6px 18px;
    font-size: 13px;
    font-weight: 700;
    color: #555;
    cursor: pointer;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    transition:
      background 0.15s,
      color 0.15s,
      border-color 0.15s;
  }

  .tab-btn.active {
    background: #2a2000;
    color: #e8a020;
    border-color: #e8a020;
  }

  .back-btn {
    background: none;
    border: none;
    font-size: 14px;
    color: #e8a020;
    cursor: pointer;
    padding: 4px 0;
    min-width: 60px;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.04em;
  }

  .edit-btn {
    background: none;
    border: none;
    font-size: 14px;
    color: #e8a020;
    cursor: pointer;
    padding: 4px 0;
    min-width: 60px;
    text-align: right;
    font-weight: 700;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.04em;
  }

  .edit-btn.active {
    color: #aa3a3a;
  }

  /* ── Search ── */
  .search-wrap {
    padding: 12px 16px;
    background: #0e0e0e;
    border-bottom: 1px solid #2a2a2a;
    position: relative;
  }

  .search-input {
    width: 100%;
    padding: 10px 14px;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    font-size: 14px;
    outline: none;
    box-sizing: border-box;
    background: #0e0e0e;
    color: #e8a020;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.04em;
    transition: border-color 0.15s;
  }

  .search-input::placeholder {
    color: #555;
  }

  .search-input:focus {
    border-color: #e8a020;
  }

  .search-results {
    margin-top: 6px;
    background: #0e0e0e;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    overflow: hidden;
  }

  .search-result-item {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border: none;
    background: #0e0e0e;
    cursor: pointer;
    font-size: 14px;
    color: #e8a020;
    border-bottom: 1px solid #161616;
    transition: background 0.1s;
    text-align: left;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.04em;
  }

  .search-result-item:last-child {
    border-bottom: none;
  }

  .search-result-item:hover {
    background: #1a1a1a;
  }

  .search-result-item.already {
    color: #555;
  }

  .add-icon {
    font-size: 18px;
    color: #e8a020;
    font-weight: 700;
  }

  .search-result-item.already .add-icon {
    color: #2a7a2a;
  }

  .stop-result-name {
    font-weight: 700;
    display: block;
    color: #e8a020;
  }

  .stop-result-code {
    font-size: 11px;
    color: #555;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.05em;
  }

  /* ── Lists ── */
  .fav-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
  }

  .fav-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #0e0e0e;
    border-radius: 8px;
    padding: 14px 16px;
    margin-bottom: 8px;
    border: 1px solid #2a2a2a;
    transition: border-color 0.15s;
  }

  .fav-row:hover {
    border-color: #3a3000;
  }

  .fav-route-pill {
    font-size: 16px;
    font-weight: 700;
    color: #e8a020;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.04em;
  }

  .stop-code-label {
    font-size: 11px;
    color: #555;
    margin-top: 2px;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.05em;
  }

  .remove-btn {
    background: #2a0a0a;
    color: #aa3a3a;
    border: 1px solid #4a1a1a;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    transition: background 0.15s;
  }

  .remove-btn:hover {
    background: #3a1010;
  }

  /* ── Empty state ── */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 60px 20px;
    color: #555;
    font-size: 13px;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.05em;
  }

  .empty-icon {
    font-size: 48px;
    margin-bottom: 8px;
    opacity: 0.4;
  }

  .empty-sub {
    font-size: 12px;
    color: #333;
    text-align: center;
    letter-spacing: 0.04em;
  }
</style>
