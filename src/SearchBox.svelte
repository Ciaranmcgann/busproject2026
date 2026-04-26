<script>
  import { createEventDispatcher } from "svelte";

  const dispatch = createEventDispatcher();

  let value = "";
  let suggestions = [];
  let activeIndex = -1;

  export let routes = [];
  let allRoutes = [];

  $: allRoutes = routes;

  function normalize(str) {
    return (str || "").replace(/\s/g, "").toLowerCase();
  }

  function getSuggestions(term) {
    const normalizedTerm = normalize(term);
    const uniqueRoutes = [...new Set(allRoutes)];

    const prefixMatches = uniqueRoutes.filter((r) =>
      normalize(r).startsWith(normalizedTerm)
    );

    const partialMatches = uniqueRoutes.filter(
      (r) =>
        !normalize(r).startsWith(normalizedTerm) &&
        normalize(r).includes(normalizedTerm)
    );

    return [...prefixMatches, ...partialMatches].slice(0, 8);
  }

  function handleInput() {
    const term = value;
    activeIndex = -1;

    if (!term.trim()) {
      suggestions = [];
      dispatch("search", "");
      return;
    }

    suggestions = getSuggestions(term);

    const exactMatch = allRoutes.find((r) => normalize(r) === normalize(term));
    dispatch("search", exactMatch ?? "");
  }

  function selectSuggestion(s) {
    value = s;
    suggestions = [];
    activeIndex = -1;
    dispatch("search", s);
  }

  function handleKeydown(event) {
    if (!suggestions.length) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % suggestions.length;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0) {
        selectSuggestion(suggestions[activeIndex]);
      } else {
        selectSuggestion(suggestions[0]);
      }
    }

    if (event.key === "Escape") {
      suggestions = [];
    }
  }
</script>

<div class="search-container">
  <input
    type="text"
    placeholder="Search bus route"
    bind:value
    on:input={handleInput}
    on:keydown={handleKeydown}
  />

  {#if suggestions.length > 0}
    <ul class="dropdown">
      {#each suggestions as s, i}
        <li
          class:selected={i === activeIndex}
          on:click={() => selectSuggestion(s)}
        >
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
    width: 300px;
  }

  input {
    width: 100%;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid #2a2a2a;
    font-size: 16px;
    outline: none;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.7);
    background: #0e0e0e;
    color: #e8a020;
    font-family: "Courier New", Courier, monospace;
    letter-spacing: 0.04em;
    box-sizing: border-box;
  }

  input::placeholder {
    color: #555;
    letter-spacing: 0.06em;
  }

  input:focus {
    border-color: #e8a020;
    background: #0e0e0e;
  }

  .dropdown {
    margin-top: 6px;
    background: #0e0e0e;
    border: 1px solid #2a2a2a;
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.8);
    max-height: 240px;
    overflow-y: auto;
    padding: 4px 0;
    list-style: none;
    font-family: "Courier New", Courier, monospace;
    animation: fadeIn 0.15s ease;
  }

  .dropdown li {
    padding: 10px 14px;
    cursor: pointer;
    font-size: 14px;
    color: #e8a020;
    letter-spacing: 0.04em;
    border-bottom: 1px solid #161616;
    transition:
      background 0.1s ease,
      color 0.1s ease;
  }

  .dropdown li:last-child {
    border-bottom: none;
  }

  .dropdown li:hover,
  .dropdown li.selected {
    background: #1a1a1a;
    color: #e8a020;
    border-left: 2px solid #e8a020;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
