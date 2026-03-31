<script>
  import { createEventDispatcher, onMount } from "svelte";

  const dispatch = createEventDispatcher();

  export let favourites = [];
  export let favouritesMode = false;

  function toggleFavourite(route) {
    dispatch("toggleFavourite", route);
  }

  function toggleMode() {
    dispatch("toggleMode");
  }

  let localFavourites = [];

  // Keep local copy in sync
  $: localFavourites = favourites;
</script>

<div class="footer">
  <div class="footer-header">
    <button class="toggle-btn" on:click={toggleMode}>
      {favouritesMode ? "⭐ Favourites ON" : "☆ Favourites OFF"}
    </button>
  </div>

  <div class="favourites-list">
    {#if localFavourites.length === 0}
      <div class="empty">No favourites added</div>
    {:else}
      {#each localFavourites as fav}
        <div class="fav-item">
          <span class="fav-name">{fav}</span>
          <button class="remove-btn" on:click={() => toggleFavourite(fav)}>
            ✕
          </button>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .footer {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;

    background: white;
    border-top: 1px solid #ddd;
    z-index: 1000;

    padding: 10px;
    max-height: 200px;
    overflow-y: auto;

    box-shadow: 0 -2px 6px rgba(0, 0, 0, 0.1);
  }

  .footer-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .toggle-btn {
    background: #1a73e8;
    color: white;
    border: none;
    padding: 6px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
  }

  .toggle-btn:hover {
    background: #1558b0;
  }

  .favourites-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .fav-item {
    background: #f1f1f1;
    padding: 6px 8px;
    border-radius: 4px;

    display: flex;
    align-items: center;
    gap: 6px;
  }

  .fav-name {
    font-size: 13px;
  }

  .remove-btn {
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 14px;
    color: #888;
  }

  .remove-btn:hover {
    color: red;
  }

  .empty {
    font-size: 13px;
    color: #777;
  }
</style>
