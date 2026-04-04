<script>
  import { createEventDispatcher } from "svelte";

  const dispatch = createEventDispatcher();

  export let favourites = [];
  export let favouritesMode = false;
  export let allRoutes = [];

  let pageOpen = false;
  let editMode = false;
  let searchTerm = "";
  let searchResults = [];

  function toggleFavourite(route) {
    dispatch("toggleFavourite", route);
  }

  function toggleMode() {
    dispatch("toggleMode");
  }

  function openPage() {
    pageOpen = true;
    editMode = false;
    searchTerm = "";
    searchResults = [];
  }

  function closePage() {
    pageOpen = false;
    editMode = false;
    searchTerm = "";
    searchResults = [];
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
</script>

<!-- Footer button -->
<div class="footer">
  <button class="fav-open-btn" on:click={openPage}>
    <span class="star">⭐</span>
    <span class="label">Favourites</span>
    {#if favourites.length > 0}
      <span class="badge">{favourites.length}</span>
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

<!-- Favourites full-screen page -->
{#if pageOpen}
  <div class="fav-page">
    <div class="fav-page-header">
      <button class="back-btn" on:click={closePage}>← Back</button>
      <h2>Favourites</h2>
      <button
        class="edit-btn"
        class:active={editMode}
        on:click={() => (editMode = !editMode)}
      >
        {editMode ? "Done" : "Edit"}
      </button>
    </div>

    <!-- Search bar -->
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
              <span class="add-icon">
                {favourites.includes(normalize(result)) ? "✓" : "+"}
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Favourites list -->
    <div class="fav-list">
      {#if favourites.length === 0}
        <div class="empty">
          <div class="empty-icon">☆</div>
          <div>No favourites yet</div>
          <div class="empty-sub">Search for a route above to add one</div>
        </div>
      {:else}
        {#each favourites as fav}
          <div class="fav-row">
            <div class="fav-route-pill">{fav}</div>
            {#if editMode}
              <button class="remove-btn" on:click={() => toggleFavourite(fav)}>
                Remove
              </button>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .footer {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 100px;
    background: white;
    border-top: 1px solid #e0e0e0;
    z-index: 1000;
    display: flex;
    align-items: center;
    padding: 0 12px;
    padding-bottom: env(safe-area-inset-bottom);
    gap: 8px;
    box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.08);
  }
  .fav-open-btn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    background: #f5f5f5;
    border: none;
    border-radius: 10px;
    padding: 20px 14px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    color: #222;
    transition: background 0.15s;
  }

  .fav-open-btn:hover {
    background: #ebebeb;
  }

  .label {
    flex: 1;
    text-align: left;
  }

  .badge {
    background: #1a73e8;
    color: white;
    font-size: 11px;
    font-weight: 700;
    border-radius: 10px;
    padding: 2px 7px;
    min-width: 20px;
    text-align: center;
  }

  .mode-btn {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    border: 1px solid #ddd;
    background: white;
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
    background: #fff8e1;
    border-color: #f9a825;
  }

  .fav-page {
    position: fixed;
    inset: 0;
    background: #f8f8f8;
    z-index: 2000;
    display: flex;
    flex-direction: column;
  }

  .fav-page-header {
    display: flex;
    align-items: center;
    padding: 16px;
    background: white;
    border-bottom: 1px solid #e0e0e0;
    gap: 12px;
  }

  .fav-page-header h2 {
    flex: 1;
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    text-align: center;
  }

  .back-btn {
    background: none;
    border: none;
    font-size: 15px;
    color: #1a73e8;
    cursor: pointer;
    padding: 4px 0;
    min-width: 60px;
  }

  .edit-btn {
    background: none;
    border: none;
    font-size: 15px;
    color: #1a73e8;
    cursor: pointer;
    padding: 4px 0;
    min-width: 60px;
    text-align: right;
    font-weight: 500;
  }

  .edit-btn.active {
    color: #e53935;
  }

  .search-wrap {
    padding: 12px 16px;
    background: white;
    border-bottom: 1px solid #e0e0e0;
    position: relative;
  }

  .search-input {
    width: 100%;
    padding: 10px 14px;
    border: 1px solid #ddd;
    border-radius: 10px;
    font-size: 15px;
    outline: none;
    box-sizing: border-box;
    background: #f5f5f5;
  }

  .search-input:focus {
    border-color: #1a73e8;
    background: white;
  }

  .search-results {
    margin-top: 6px;
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 10px;
    overflow: hidden;
  }

  .search-result-item {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border: none;
    background: white;
    cursor: pointer;
    font-size: 15px;
    border-bottom: 1px solid #f0f0f0;
    transition: background 0.1s;
  }

  .search-result-item:last-child {
    border-bottom: none;
  }

  .search-result-item:hover {
    background: #f5f5f5;
  }

  .search-result-item.already {
    color: #888;
  }

  .add-icon {
    font-size: 18px;
    color: #1a73e8;
    font-weight: 700;
  }

  .search-result-item.already .add-icon {
    color: #4caf50;
  }

  .fav-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
  }

  .fav-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: white;
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
  }

  .fav-route-pill {
    font-size: 16px;
    font-weight: 600;
    color: #222;
  }

  .remove-btn {
    background: #ffebee;
    color: #e53935;
    border: none;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .remove-btn:hover {
    background: #ffcdd2;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 60px 20px;
    color: #999;
    font-size: 15px;
  }

  .empty-icon {
    font-size: 48px;
    margin-bottom: 8px;
  }

  .empty-sub {
    font-size: 13px;
    color: #bbb;
  }
</style>
