async function loadJson(basePath, name) {
  const response = await fetch(`${basePath}/data/${name}`);
  if (!response.ok) throw new Error(`Failed to load ${name}`);
  return response.json();
}

function money(value) {
  const num = Number(value || 0);
  if (Number.isNaN(num)) return "—";
  return `$${Number.isInteger(num) ? num : num.toFixed(2).replace(/\.00$/, "")}`;
}

function option(text, value) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = text;
  return node;
}

function csvEscape(value) {
  const text = String(value == null ? "" : value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

async function initTradeMachine() {
  const body = document.body;
  if (body.dataset.page !== "trade-machine") return;
  const basePath = body.dataset.basepath || ".";
  const [teams, assets, cap] = await Promise.all([
    loadJson(basePath, "teams.json"),
    loadJson(basePath, "trade_machine_assets.json"),
    loadJson(basePath, "cap_table.json"),
  ]);
  const capByTeam = Object.fromEntries(cap.map((row) => [row.team_name, row]));
  const assetById = Object.fromEntries(assets.map((row) => [row.asset_id, row]));
  const slots = ["a", "b", "c", "d"].map((suffix) => ({
    suffix,
    team: document.getElementById(`team-${suffix}`),
    players: document.getElementById(`players-${suffix}`),
    picks: document.getElementById(`picks-${suffix}`),
    routes: document.getElementById(`routes-${suffix}`),
  }));
  const result = document.getElementById("trade-results");
  const submissionPreview = document.getElementById("commissioner-submission");
  const copyButton = document.getElementById("copy-discord-summary");
  const csvButton = document.getElementById("download-trade-csv");
  const jsonButton = document.getElementById("download-trade-json");
  const routingState = {};

  function selectedTeamNames() {
    return slots.map((slot) => slot.team.value).filter(Boolean);
  }

  function fillTeamOptions() {
    slots.forEach((slot) => {
      const currentTeam = slot.team.value;
      slot.team.innerHTML = "";
      slot.team.appendChild(option("Select team", ""));
      teams.forEach((team) => {
        slot.team.appendChild(option(team.team_name, team.team_name));
      });
      slot.team.value = currentTeam;
    });
  }

  function assetLabel(asset) {
    if (asset.asset_type === "PLAYER") return `${asset.display_name} (${money(asset.salary_value)})`;
    if (asset.asset_type === "AMNESTY") return `${asset.display_name} (rights only)`;
    return asset.display_name;
  }

  function fillAssetSelect(select, teamName, assetTypes) {
    const previous = new Set(Array.from(select.selectedOptions).map((node) => node.value));
    select.innerHTML = "";
    const allowedTypes = Array.isArray(assetTypes) ? assetTypes : [assetTypes];
    assets
      .filter((row) => row.team_name === teamName && allowedTypes.includes(row.asset_type))
      .forEach((row) => {
        const node = option(assetLabel(row), row.asset_id);
        if (previous.has(row.asset_id)) node.selected = true;
        select.appendChild(node);
      });
  }

  function selectedAssetsForSlot(slot) {
    return [slot.players, slot.picks]
      .reduce((items, select) => items.concat(Array.from(select.selectedOptions).map((node) => assetById[node.value]).filter(Boolean)), []);
  }

  function renderRoutesForSlot(slot) {
    const selectedAssets = selectedAssetsForSlot(slot);
    const activeTeams = selectedTeamNames();
    const routeKey = slot.suffix;
    if (!routingState[routeKey]) routingState[routeKey] = {};
    slot.routes.innerHTML = "";
    if (!slot.team.value || selectedAssets.length === 0) {
      slot.routes.innerHTML = "<p class='muted'>Select players and/or picks to assign destinations.</p>";
      return;
    }
    selectedAssets.forEach((asset) => {
      const row = document.createElement("div");
      row.className = "route-row";
      const title = document.createElement("strong");
      title.textContent = asset.display_name;
      const meta = document.createElement("span");
      meta.textContent = asset.asset_type === "PLAYER"
        ? `Outgoing salary ${money(asset.salary_value)}`
        : asset.asset_type === "AMNESTY"
          ? "Amnesty right salary impact $0"
          : "Draft pick salary impact $0";
      const destination = document.createElement("select");
      destination.appendChild(option("Receiving team", ""));
      activeTeams
        .filter((teamName) => teamName && teamName !== slot.team.value)
        .forEach((teamName) => destination.appendChild(option(teamName, teamName)));
      const current = routingState[routeKey][asset.asset_id];
      destination.value = current && current !== slot.team.value ? current : "";
      destination.addEventListener("change", () => {
        routingState[routeKey][asset.asset_id] = destination.value;
        render();
      });
      row.appendChild(title);
      row.appendChild(meta);
      row.appendChild(destination);
      slot.routes.appendChild(row);
    });
  }

  function buildPayload() {
    return {
      teams: slots
        .filter((slot) => slot.team.value)
        .map((slot) => ({
          team_name: slot.team.value,
          outgoing_assets: selectedAssetsForSlot(slot).map((asset) => ({
            asset_id: asset.asset_id,
            destination_team_name: ((routingState[slot.suffix] || {})[asset.asset_id]) || "",
          })),
        })),
    };
  }

  function buildSubmissionText(payload, validation) {
    const timestamp = new Date().toISOString();
    const teamNames = payload.teams.map((row) => row.team_name).filter(Boolean);
    const lines = [
      "WTT Trade Submission",
      `Generated: ${timestamp}`,
      `Teams: ${teamNames.join(" | ") || "None"}`,
      "",
      "Asset Routing",
    ];
    payload.teams.forEach((teamRow) => {
      lines.push(`${teamRow.team_name}`);
      if (!teamRow.outgoing_assets.length) {
        lines.push("- No outgoing assets selected");
        return;
      }
      teamRow.outgoing_assets.forEach((assetRow) => {
        const asset = assetById[assetRow.asset_id];
        const assetName = asset ? asset.display_name : assetRow.asset_id;
        const assetSalary = asset ? money(asset.salary_value) : "$0";
        lines.push(`- ${assetName} -> ${assetRow.destination_team_name || "UNASSIGNED"} (${assetSalary})`);
      });
    });
    lines.push("");
    lines.push("Cap Summary");
    (validation.teamCards || []).forEach((card) => {
      lines.push(`- ${card.teamName}: outgoing ${money(card.outgoing)}, incoming ${money(card.incoming)}, post-trade hard-cap space ${money(card.postTrade)}`);
    });
    lines.push("");
    lines.push(`Validation: ${validation.valid ? "VALID pending commissioner review" : "INVALID"}`);
    if (validation.issues.length) {
      lines.push("Issues:");
      validation.issues.forEach((issue) => lines.push(`- ${issue}`));
    }
    if (validation.warnings.length) {
      lines.push("Warnings:");
      validation.warnings.forEach((warning) => lines.push(`- ${warning}`));
    }
    return lines.join("\n");
  }

  function downloadText(filename, text, mimeType) {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function validate(payload) {
    const issues = [];
    const warnings = [];
    const activeTeams = payload.teams.map((row) => row.team_name).filter(Boolean);
    if (activeTeams.length < 2) issues.push("Select at least two teams to start the trade check.");
    if (activeTeams.length > 4) issues.push("Trades may involve at most four teams.");
    if (new Set(activeTeams).size !== activeTeams.length) issues.push("Each selected team must be unique.");
    const outgoingByTeam = Object.fromEntries(activeTeams.map((teamName) => [teamName, 0]));
    const incomingByTeam = Object.fromEntries(activeTeams.map((teamName) => [teamName, 0]));
    const outgoingAssetsByTeam = Object.fromEntries(activeTeams.map((teamName) => [teamName, []]));
    const incomingAssetsByTeam = Object.fromEntries(activeTeams.map((teamName) => [teamName, []]));
    const seenAssets = new Set();
    let selectedAssetCount = 0;

    payload.teams.forEach((teamRow) => {
      teamRow.outgoing_assets.forEach((assetRow) => {
        const asset = assetById[assetRow.asset_id];
        if (!asset) {
          issues.push(`${assetRow.asset_id} is not tradable in the current season context.`);
          return;
        }
        if (seenAssets.has(asset.asset_id)) {
          issues.push(`${asset.display_name} appears more than once in the same trade.`);
          return;
        }
        seenAssets.add(asset.asset_id);
        selectedAssetCount += 1;
        if (asset.team_name !== teamRow.team_name) {
          issues.push(`${asset.display_name} is not controlled by ${teamRow.team_name}.`);
          return;
        }
        if (!assetRow.destination_team_name) {
          issues.push(`${asset.display_name} is missing a receiving team.`);
          return;
        }
        if (assetRow.destination_team_name === teamRow.team_name) {
          issues.push(`${asset.display_name} cannot be routed back to ${teamRow.team_name}.`);
          return;
        }
        if (!incomingByTeam.hasOwnProperty(assetRow.destination_team_name)) {
          issues.push(`${asset.display_name} is routed to a team outside the current trade.`);
          return;
        }
        outgoingByTeam[teamRow.team_name] += Number(asset.salary_value || 0);
        incomingByTeam[assetRow.destination_team_name] += Number(asset.salary_value || 0);
        outgoingAssetsByTeam[teamRow.team_name].push(asset);
        incomingAssetsByTeam[assetRow.destination_team_name].push({ ...asset, source_team_name: teamRow.team_name });
        if (asset.asset_type === "ROOKIE_PICK" && Number(asset.round || 0) === 1) {
          warnings.push("Future-first trade horizon and protected-pick restrictions are not configured in the current authoritative validator.");
        }
      });
    });

    if (selectedAssetCount === 0) issues.push("Select at least one player or pick before validating the trade.");
    const uniqueWarnings = Array.from(new Set(warnings));
    const teamCards = activeTeams.map((teamName) => {
      const currentHardCapSpace = Number((capByTeam[teamName] || {}).hard_cap_space || 0);
      const outgoing = outgoingByTeam[teamName] || 0;
      const incoming = incomingByTeam[teamName] || 0;
      const postTrade = currentHardCapSpace + outgoing - incoming;
      const valid = postTrade >= 0;
      if (!valid) issues.push(`${teamName} would exceed the hard cap after this trade.`);
      return {
        teamName,
        outgoing,
        incoming,
        currentHardCapSpace,
        postTrade,
        valid,
        outgoingAssets: outgoingAssetsByTeam[teamName] || [],
        incomingAssets: incomingAssetsByTeam[teamName] || [],
      };
    });
    return { valid: issues.length === 0, issues, warnings: uniqueWarnings, teamCards };
  }

  function render() {
    slots.forEach((slot) => renderRoutesForSlot(slot));
    const payload = buildPayload();
    const validation = validate(payload);
    const teamCards = validation.teamCards || [];
    const packages = teamCards.map((card) => `
      <article class="trade-panel">
        <h3>${card.teamName}</h3>
        <p class="muted">Outgoing: ${card.outgoingAssets.length ? card.outgoingAssets.map((asset) => asset.display_name).join(", ") : "None"}</p>
        <p class="muted">Incoming: ${card.incomingAssets.length ? card.incomingAssets.map((asset) => `${asset.display_name} from ${asset.source_team_name}`).join(", ") : "None"}</p>
      </article>
    `).join("");
    result.innerHTML = `
      <div class="card-grid">
        ${teamCards.map((card) => `
          <article class="metric-card">
            <span class="metric-label">${card.teamName}</span>
            <strong class="metric-value">${money(card.postTrade)}</strong>
            <p class="metric-note">Outgoing ${money(card.outgoing)} • Incoming ${money(card.incoming)}</p>
            <p class="metric-note">${card.valid ? "Still valid under hard cap" : "Invalid under hard cap"}</p>
          </article>
        `).join("")}
      </div>
      ${packages ? `<section class="trade-grid">${packages}</section>` : ""}
      ${validation.warnings.length ? `<section class="notice warning">${validation.warnings.join(" ")}</section>` : ""}
      ${validation.issues.length ? `<section class="notice warning">${validation.issues.join(" ")}</section>` : ""}
      <section class="notice warning">
        ${validation.valid ? "VALID pending commissioner validation." : "INVALID because one or more teams would exceed the hard cap, route an ineligible asset, or leave routing incomplete."}
      </section>
    `;
    submissionPreview.value = buildSubmissionText(payload, validation);
  }

  function refreshSlot(slot) {
    fillAssetSelect(slot.players, slot.team.value, "PLAYER");
    fillAssetSelect(slot.picks, slot.team.value, ["ROOKIE_PICK", "AMNESTY"]);
  }

  fillTeamOptions();
  slots.forEach((slot) => {
    slot.team.addEventListener("change", () => {
      refreshSlot(slot);
      render();
    });
    slot.players.addEventListener("change", render);
    slot.picks.addEventListener("change", render);
  });
  slots.forEach((slot) => refreshSlot(slot));
  copyButton.addEventListener("click", async () => {
    if (!submissionPreview.value) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(submissionPreview.value);
    } else {
      submissionPreview.focus();
      submissionPreview.select();
      document.execCommand("copy");
    }
  });
  csvButton.addEventListener("click", () => {
    const payload = buildPayload();
    const rows = [["source_team_name", "asset_id", "asset_type", "asset_name", "destination_team_name", "salary_value"]];
    payload.teams.forEach((teamRow) => {
      teamRow.outgoing_assets.forEach((assetRow) => {
        const asset = assetById[assetRow.asset_id] || {};
        rows.push([
          teamRow.team_name,
          assetRow.asset_id,
          asset.asset_type || "",
          asset.display_name || assetRow.asset_id,
          assetRow.destination_team_name || "",
          asset.salary_value || 0,
        ]);
      });
    });
    downloadText("wtt_trade_submission.csv", rows.map((row) => row.map(csvEscape).join(",")).join("\n"), "text/csv;charset=utf-8");
  });
  jsonButton.addEventListener("click", () => {
    const payload = buildPayload();
    const validation = validate(payload);
    downloadText("wtt_trade_submission.json", JSON.stringify({ payload, validation }, null, 2), "application/json;charset=utf-8");
  });
  render();
}

initTradeMachine().catch((error) => {
  const result = document.getElementById("trade-results");
  if (result) result.textContent = error.message;
});

async function initTradeBlock() {
  const body = document.body;
  if (body.dataset.page !== "trade-block") return;
  const basePath = body.dataset.basepath || ".";
  const [teams, assets] = await Promise.all([
    loadJson(basePath, "teams.json"),
    loadJson(basePath, "trade_machine_assets.json"),
  ]);
  const storageKey = "wtt-trade-block-posts-v1";
  const form = document.getElementById("trade-block-form");
  const teamSelect = document.getElementById("trade-block-team");
  const offeredPlayers = document.getElementById("trade-block-offered-players");
  const offeredPicks = document.getElementById("trade-block-offered-picks");
  const statusSelect = document.getElementById("trade-block-status");
  const seekingInput = document.getElementById("trade-block-seeking");
  const notesInput = document.getElementById("trade-block-notes");
  const filterSelect = document.getElementById("trade-block-filter");
  const list = document.getElementById("trade-block-list");
  const exportButton = document.getElementById("trade-block-export");
  const clearButton = document.getElementById("trade-block-clear");

  function readPosts() {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || "[]");
    } catch (error) {
      return [];
    }
  }

  function writePosts(posts) {
    localStorage.setItem(storageKey, JSON.stringify(posts));
  }

  function fillTeams(selectNode) {
    const current = selectNode.value;
    selectNode.innerHTML = "";
    selectNode.appendChild(option("All teams", ""));
    teams.forEach((team) => selectNode.appendChild(option(team.team_name, team.team_name)));
    selectNode.value = current;
  }

  function fillOfferSelects(teamName) {
    offeredPlayers.innerHTML = "";
    offeredPicks.innerHTML = "";
    assets
      .filter((asset) => asset.team_name === teamName && asset.asset_type === "PLAYER")
      .forEach((asset) => offeredPlayers.appendChild(option(asset.display_name, asset.asset_id)));
    assets
      .filter((asset) => asset.team_name === teamName && ["ROOKIE_PICK", "AMNESTY"].includes(asset.asset_type))
      .forEach((asset) => offeredPicks.appendChild(option(asset.display_name, asset.asset_id)));
  }

  function assetNamesByIds(ids) {
    const byId = Object.fromEntries(assets.map((asset) => [asset.asset_id, asset.display_name]));
    return (ids || []).map((id) => byId[id] || id);
  }

  function renderPosts() {
    const filterTeam = filterSelect.value;
    const posts = readPosts()
      .filter((post) => !filterTeam || post.team_name === filterTeam)
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    if (!posts.length) {
      list.innerHTML = "<div class='trade-block-empty'>No trade-block posts yet on this browser. Add one on the left to start the board.</div>";
      return;
    }
    list.innerHTML = posts.map((post) => `
      <article class="trade-block-post">
        <h3>${post.team_name}</h3>
        <div class="trade-block-meta">${post.status} • Updated ${new Date(post.updated_at).toLocaleString()}</div>
        <p class="trade-block-assets"><strong>Offering:</strong> ${assetNamesByIds(post.offered_player_ids).concat(assetNamesByIds(post.offered_pick_ids)).join(", ") || "Open to discussion"}</p>
        <p class="trade-block-assets"><strong>Seeking:</strong> ${post.seeking || "Best value / flexible"}</p>
        <p class="trade-block-assets"><strong>Notes:</strong> ${post.notes || "—"}</p>
      </article>
    `).join("");
  }

  fillTeams(filterSelect);
  teamSelect.innerHTML = "";
  teamSelect.appendChild(option("Select team", ""));
  teams.forEach((team) => teamSelect.appendChild(option(team.team_name, team.team_name)));

  teamSelect.addEventListener("change", () => fillOfferSelects(teamSelect.value));
  filterSelect.addEventListener("change", renderPosts);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!teamSelect.value) return;
    const posts = readPosts().filter((post) => post.team_name !== teamSelect.value);
    posts.push({
      team_name: teamSelect.value,
      status: statusSelect.value || "Open",
      offered_player_ids: Array.from(offeredPlayers.selectedOptions).map((node) => node.value),
      offered_pick_ids: Array.from(offeredPicks.selectedOptions).map((node) => node.value),
      seeking: seekingInput.value.trim(),
      notes: notesInput.value.trim(),
      updated_at: new Date().toISOString(),
    });
    writePosts(posts);
    renderPosts();
  });
  exportButton.addEventListener("click", () => {
    downloadText("wtt_trade_block.json", JSON.stringify(readPosts(), null, 2), "application/json;charset=utf-8");
  });
  clearButton.addEventListener("click", () => {
    if (!teamSelect.value) return;
    writePosts(readPosts().filter((post) => post.team_name !== teamSelect.value));
    renderPosts();
  });
  renderPosts();
}

function initTradeLogFilters() {
  const body = document.body;
  if (body.dataset.page !== "trade-log") return;
  const seasonSelect = document.getElementById("trade-season-filter");
  if (!seasonSelect) return;
  const sections = Array.from(document.querySelectorAll(".trade-season-section"));
  function renderTradeLogFilter() {
    const season = seasonSelect.value;
    sections.forEach((section) => {
      section.style.display = (!season || season === "all" || section.dataset.seasonKey === season) ? "" : "none";
    });
  }
  seasonSelect.addEventListener("change", renderTradeLogFilter);
  renderTradeLogFilter();
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

async function initUfaBoard() {
  const body = document.body;
  if (body.dataset.page !== "ufa-board") return;
  const basePath = body.dataset.basepath || ".";
  const [rows] = await Promise.all([loadJson(basePath, "ufa_pool.json")]);
  const search = document.getElementById("ufa-search");
  const position = document.getElementById("ufa-position-filter");
  const rank = document.getElementById("ufa-rank-filter");
  const sort = document.getElementById("ufa-sort");
  const resultCount = document.getElementById("ufa-result-count");
  const list = document.getElementById("ufa-market-list");
  if (!search || !position || !rank || !sort || !resultCount || !list) return;

  const positions = Array.from(new Set(rows.flatMap((row) => String(row.position || "").split(",").map((value) => value.trim()).filter(Boolean)))).sort();
  positions.forEach((value) => position.appendChild(option(value, value)));
  const numeric = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : Number.POSITIVE_INFINITY;
  };
  const displayNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? (Number.isInteger(number) ? String(number) : number.toFixed(1)) : "—";
  };

  function render() {
    const query = search.value.trim().toLowerCase();
    const selectedPosition = position.value;
    const maximumRank = Number(rank.value || 0);
    const filtered = rows.filter((row) => {
      const nameMatches = !query || String(row.player_name || "").toLowerCase().includes(query);
      const positionMatches = !selectedPosition || String(row.position || "").split(",").map((value) => value.trim()).includes(selectedPosition);
      const rankMatches = !maximumRank || numeric(row.average_rank) <= maximumRank;
      return nameMatches && positionMatches && rankMatches;
    }).sort((left, right) => {
      if (sort.value === "name") return String(left.player_name).localeCompare(String(right.player_name));
      const field = sort.value === "adp" ? "average_pick" : "average_rank";
      return numeric(left[field]) - numeric(right[field]) || String(left.player_name).localeCompare(String(right.player_name));
    });
    resultCount.textContent = `${filtered.length} of ${rows.length} players`;
    list.innerHTML = filtered.length ? filtered.map((row) => `
      <tr>
        <td class="market-player">${escapeHtml(row.player_name)}</td>
        <td class="market-position">${escapeHtml(row.position || "—")}</td>
        <td>${displayNumber(row.average_rank)}</td>
        <td>${displayNumber(row.average_pick)}</td>
      </tr>`).join("") : '<tr><td colspan="4" class="muted">No players match the selected market filters.</td></tr>';
  }

  [search, position, rank, sort].forEach((control) => control.addEventListener("input", render));
  render();
}

initTradeLogFilters();
initUfaBoard().catch((error) => {
  const list = document.getElementById("ufa-market-list");
  if (list) list.innerHTML = `<tr><td colspan="4">${escapeHtml(error.message)}</td></tr>`;
});
initTradeBlock().catch((error) => {
  const list = document.getElementById("trade-block-list");
  if (list) list.textContent = error.message;
});
