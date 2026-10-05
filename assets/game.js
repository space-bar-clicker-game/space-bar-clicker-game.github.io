(function () {
  var SBC = window.SBC || {};

  function tx(key, fallback) {
    var value = SBC[key];
    return value == null || value === "" ? fallback : value;
  }

  function esc(value) {
    return String(value).replace(/[&<>]/g, function (ch) {
      if (ch === "&") return "&amp;";
      if (ch === "<") return "&lt;";
      return "&gt;";
    });
  }

  function fill(template, map) {
    return String(template).replace(/\{(\w+)\}/g, function (_, key) {
      return map[key] == null ? "" : String(map[key]);
    });
  }

  function fillHtml(template, map) {
    var html = esc(template).replace(/\{b\}/g, "<b>").replace(/\{\/b\}/g, "</b>");
    return html.replace(/\{(\w+)\}/g, function (_, key) {
      return map[key] == null ? "" : String(map[key]);
    });
  }

  var SAVE_KEY = "sbc_save_v1";
  var BOARD_URL = "https://spacebar-scores.gerom-devis.workers.dev";
  var MUTE_KEY = "sbc_mute_v1";
  var ITEM_DEFS = [
    { kind: "flat", cost: 30, add: 0.2, costMul: 1.12 },
    { kind: "flat", cost: 120, add: 3, costMul: 1.3 },
    { kind: "flat", cost: 500, add: 20, costMul: 1.4 },
    { kind: "mult", cost: 6000, mult: 2, costMul: 1.9 },
    { kind: "grow", cost: 10000, add: 150, addMul: 1.22, costMul: 1.4 },
    { kind: "grow", cost: 200000, add: 600, addMul: 1.25, costMul: 1.4 },
    { kind: "grow", cost: 800000, add: 3500, addMul: 1.28, costMul: 1.4 },
    { kind: "grow", cost: 2000000, add: 25000, addMul: 1.3, costMul: 1.4 },
    { kind: "grow", cost: 10000000, add: 100000, addMul: 1.3, costMul: 1.4 },
    { kind: "grow", cost: 80000000, add: 1000000, addMul: 1.3, costMul: 1.4 },
    { kind: "grow", cost: 7e12, add: 1e10, addMul: 1.3, costMul: 1.4 },
    { kind: "grow", cost: 1.7e15, add: 4e12, addMul: 1.35, costMul: 1.45 },
    { kind: "grow", cost: 5e16, add: 1.4e14, addMul: 1.35, costMul: 1.45 },
    { kind: "grow", cost: 2.5e19, add: 5e14, addMul: 1.35, costMul: 1.45 }
  ];

  var copy = Array.isArray(SBC.items) ? SBC.items : [];
  var items = ITEM_DEFS.map(function (def, index) {
    var text = copy[index] || {};
    return {
      name: text.name || "Helper",
      blurb: text.blurb || "",
      kind: def.kind,
      cost: def.cost,
      add: def.add || 0,
      addMul: def.addMul || 1,
      mult: def.mult || 1,
      costMul: def.costMul,
      lvl: 0,
      prod: 0
    };
  });

  var score = 0;
  var clickPower = 1;
  var bestBurst = 0;
  var taps = [];
  var muted = false;
  var pointerInside = false;
  var audioCtx = null;
  var lastTick = performance.now();
  var saveTimer = 0;
  var rainCount = 0;
  var youName = "";
  var board = { entries: [], saves: 0, players: 0 };

  var counterEl = document.getElementById("counter");
  var perSecondEl = document.getElementById("perSecond");
  var barEl = document.getElementById("spacebar");
  var gameEl = document.getElementById("game");
  var shellEl = document.getElementById("gameShell");
  var topPanel = document.getElementById("topPanel");
  var topMsg = document.getElementById("topMsg");
  var topPreview = document.getElementById("topPreview");
  var topName = document.getElementById("topName");

  if (!counterEl || !barEl || !gameEl) return;

  function formatCompact(value) {
    var n = Math.floor(Math.max(0, value));
    if (!isFinite(n)) return "∞";
    var locale = SBC.locale || "en";
    if (n < 1000000) {
      try { return n.toLocaleString(locale); }
      catch (err) { return n.toLocaleString("en"); }
    }
    var units = ["M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"];
    var v = n / 1000000;
    var i = 0;
    while (v >= 1000 && i < units.length - 1) {
      v /= 1000;
      i++;
    }
    if (v >= 1000) return n.toExponential(2);
    var digits = v >= 100 ? 1 : 2;
    return v.toFixed(digits) + units[i];
  }

  function formatRate(n) {
    if (n < 1000) return n.toFixed(3);
    return formatCompact(n);
  }

  function formatAdd(n) {
    if (n < 1000) {
      var rounded = Math.round(n * 10) / 10;
      return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    }
    return formatCompact(n);
  }

  function formatCost(n) {
    if (n < 1000) {
      var rounded = Math.round(n * 10) / 10;
      return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    }
    return formatCompact(n);
  }

  function currentCps() {
    var sum = 0;
    for (var i = 0; i < items.length; i++) sum += items[i].prod || 0;
    return sum;
  }

  function itemText(it) {
    if (it.kind === "mult") {
      return esc(it.blurb) + " " + fillHtml(tx("doubleHtml", "Each kit {b}doubles{/b} the clicks you make yourself."), {});
    }
    var rate = "<b>" + esc(formatAdd(it.add)) + "</b>";
    var template = it.kind === "grow"
      ? tx("nextAdds", "The next one adds {rate} per second.")
      : tx("eachAdds", "Each one adds {rate} per second.");
    return esc(it.blurb) + " " + fillHtml(template, { rate: rate });
  }

  function refreshDesc(it) {
    it.el.querySelector(".shop-desc").innerHTML = itemText(it);
  }

  function buildShop() {
    var ul = document.getElementById("shop");
    var hint = document.createElement("li");
    hint.id = "shopHint";
    hint.textContent = tx("hint", "Ten clicks open the first helper.");
    ul.appendChild(hint);
    items.forEach(function (it) {
      var li = document.createElement("li");
      li.className = "shop-item is-hidden";
      li.innerHTML = '<div class="shop-body"><h3></h3><p class="shop-desc"></p><div class="shop-cost"><span class="mini-key" aria-hidden="true"></span><span class="cost-num"></span></div></div><div class="shop-lvl"><span>x</span><b class="lvl-num">0</b></div>';
      li.querySelector("h3").textContent = it.name;
      li.querySelector(".shop-desc").innerHTML = itemText(it);
      li.addEventListener("click", function () { buy(it); });
      ul.appendChild(li);
      it.el = li;
    });
  }

  function paintShop() {
    var cps = currentCps();
    var highest = -1;
    items.forEach(function (it, i) {
      if (it.lvl > 0) highest = i;
    });
    var showUntil = (score >= 10 || cps > 0) ? highest + 1 : -1;
    var hint = document.getElementById("shopHint");
    if (hint) hint.hidden = showUntil >= 0;
    items.forEach(function (it, i) {
      var visible = i <= showUntil;
      it.el.classList.toggle("is-hidden", !visible);
      it.el.classList.toggle("can-buy", visible && score >= it.cost && isFinite(it.cost));
      it.el.querySelector(".lvl-num").textContent = String(it.lvl);
      it.el.querySelector(".cost-num").textContent = formatCost(it.cost);
    });
  }

  function paint() {
    var text = formatCompact(score);
    counterEl.textContent = text;
    var size = Math.max(2, 5.2 - Math.max(0, text.length - 3) * 0.36);
    counterEl.style.fontSize = size + "rem";
    var line = tx("perSecond", "per second") + ": " + formatRate(currentCps());
    if (clickPower > 1) line += "  ·  " + tx("tapWord", "tap") + " x" + formatCompact(clickPower);
    if (bestBurst > 0) line += "  ·  " + tx("burstWord", "burst") + " " + bestBurst + "/s";
    perSecondEl.textContent = line;
    paintShop();
    if (!topPanel.hidden) {
      topPreview.textContent = fill(tx("thisRun", "This run: {score} score · {rate}/s · burst {burst}/s"), {
        score: formatCompact(score),
        rate: formatRate(currentCps()),
        burst: String(bestBurst)
      });
    }
  }

  function noteTap(now) {
    taps.push(now);
    while (taps.length && now - taps[0] > 1000) taps.shift();
    if (taps.length > bestBurst) bestBurst = taps.length;
  }

  function spawnFloater(clientX, clientY, amount) {
    var rect = gameEl.getBoundingClientRect();
    var el = document.createElement("span");
    el.className = "floater";
    el.textContent = "+" + formatCompact(amount);
    el.style.left = (clientX - rect.left - 10) + "px";
    el.style.top = (clientY - rect.top - 10) + "px";
    gameEl.appendChild(el);
    el.addEventListener("animationend", function () { el.remove(); });
  }

  function blip(freq) {
    if (muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.value = 0.035;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.06);
      osc.stop(audioCtx.currentTime + 0.07);
    } catch (err) {}
  }

  function registerClick(clientX, clientY) {
    score += clickPower;
    noteTap(performance.now());
    if (clientX == null) {
      var rect = barEl.getBoundingClientRect();
      clientX = rect.left + rect.width / 2;
      clientY = rect.top + rect.height / 2;
    }
    spawnFloater(clientX, clientY, clickPower);
    blip(560 + Math.random() * 80);
    paint();
    scheduleSave();
  }

  function typingTarget(node) {
    if (!node || !node.tagName) return false;
    var tag = node.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
  }

  function gameActive() {
    if (!topPanel.hidden) return false;
    if (typingTarget(document.activeElement)) return false;
    return pointerInside || document.fullscreenElement === shellEl || shellEl.contains(document.activeElement);
  }

  function buy(it) {
    if (!isFinite(it.cost) || score < it.cost) return;
    score -= it.cost;
    it.lvl += 1;
    it.cost = it.cost * it.costMul;
    if (it.kind === "mult") clickPower *= it.mult;
    else {
      it.prod += it.add;
      if (it.kind === "grow") it.add *= it.addMul;
    }
    refreshDesc(it);
    blip(240);
    gameEl.classList.remove("shake");
    void gameEl.offsetWidth;
    gameEl.classList.add("shake");
    paint();
    scheduleSave();
  }

  function spawnRain() {
    var el = document.createElement("div");
    el.className = "rain-bit";
    el.style.left = Math.random() * 92 + "%";
    gameEl.appendChild(el);
    rainCount += 1;
    el.addEventListener("animationend", function () {
      el.remove();
      rainCount -= 1;
    });
  }

  function saveGame() {
    try {
      var payload = {
        score: score,
        bestBurst: bestBurst,
        items: items.map(function (it) {
          return { lvl: it.lvl, cost: it.cost, add: it.add, prod: it.prod };
        })
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    } catch (err) {}
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveGame, 350);
  }

  function loadGame() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (typeof data.score === "number" && isFinite(data.score)) score = data.score;
      if (typeof data.bestBurst === "number") bestBurst = data.bestBurst;
      if (Array.isArray(data.items)) {
        data.items.forEach(function (saved, i) {
          if (!items[i] || !saved) return;
          items[i].lvl = saved.lvl || 0;
          if (typeof saved.cost === "number") items[i].cost = saved.cost;
          if (typeof saved.add === "number") items[i].add = saved.add;
          if (typeof saved.prod === "number") items[i].prod = saved.prod;
        });
      }
      clickPower = 1;
      items.forEach(function (it) {
        if (it.kind === "mult" && it.lvl > 0) clickPower *= Math.pow(it.mult, it.lvl);
        if (it.kind === "flat" && it.lvl > 0 && !it.prod) it.prod = it.add * it.lvl;
      });
    } catch (err) {}
  }

  function readBoard() {
    return board;
  }

  function applyBoard(data) {
    var entries = data && Array.isArray(data.entries) ? data.entries : [];
    entries = entries.map(function (entry) {
      return {
        name: entry && entry.name,
        score: Number(entry && entry.score),
        cps: Number(entry && entry.cps) || 0,
        burst: Number(entry && entry.burst) || 0,
        at: Number(entry && entry.at) || 0
      };
    }).filter(function (entry) {
      return typeof entry.name === "string" && isFinite(entry.score);
    });
    board = {
      entries: entries,
      saves: data && data.saves ? data.saves : entries.length,
      players: data && data.players ? data.players : entries.length
    };
  }

  function loadBoard() {
    return fetch(BOARD_URL + "/scores").then(function (res) {
      if (!res.ok) throw new Error("board");
      return res.json();
    }).then(function (data) {
      applyBoard(data);
      return board;
    });
  }

  function boardMessage(payload) {
    var code = payload && payload.code;
    if (code === "short") return tx("msgShort", "Use at least 2 characters.");
    if (code === "score") return tx("msgZero", "Get a score above zero first.");
    if (code === "stays") return fill(tx("msgStays", "Your saved score stays: {score}."), { score: formatCompact(payload.score || 0) });
    if (code === "full") return fill(tx("msgFull", "Top 20 is full. Beat {score} to enter."), { score: formatCompact(payload.score || 0) });
    if (code === "saved") return fill(tx("msgSaved", "Saved. You are #{rank}."), { rank: String(payload.rank || "") });
    return tx("msgOffline", "The top list is unavailable right now.");
  }

  function renderTop() {
    var board = readBoard();
    var entries = board.entries;
    var bestScore = 0;
    var bestCps = 0;
    var bestBurstStat = 0;
    var combined = 0;
    entries.forEach(function (entry) {
      if (entry.score > bestScore) bestScore = entry.score;
      if ((entry.cps || 0) > bestCps) bestCps = entry.cps || 0;
      if ((entry.burst || 0) > bestBurstStat) bestBurstStat = entry.burst || 0;
      combined += entry.score;
    });
    var stats = [
      [tx("statPlayers", "Players"), String(board.players || entries.length)],
      [tx("statSaves", "Times saved"), String(board.saves || 0)],
      [tx("statBest", "Best score"), formatCompact(bestScore)],
      [tx("statRate", "Best per second"), formatRate(bestCps)],
      [tx("statBurst", "Best burst"), bestBurstStat + "/s"],
      [tx("statCombined", "Combined score"), formatCompact(combined)]
    ];
    var grid = document.getElementById("statGrid");
    grid.innerHTML = "";
    stats.forEach(function (pair) {
      var card = document.createElement("div");
      card.className = "stat-card";
      var label = document.createElement("span");
      label.textContent = pair[0];
      var value = document.createElement("strong");
      value.textContent = pair[1];
      card.appendChild(label);
      card.appendChild(value);
      grid.appendChild(card);
    });
    var body = document.getElementById("topBody");
    body.innerHTML = "";
    if (!entries.length) {
      var empty = document.createElement("tr");
      var cell = document.createElement("td");
      cell.colSpan = 6;
      cell.textContent = tx("emptyBoard", "No scores yet. Play, then leave your name.");
      empty.appendChild(cell);
      body.appendChild(empty);
      return;
    }
    entries.forEach(function (entry, index) {
      var tr = document.createElement("tr");
      if (youName && entry.name.toLowerCase() === youName.toLowerCase()) tr.className = "is-you";
      var when = entry.at ? new Date(entry.at).toLocaleString(SBC.locale || undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
      [String(index + 1), entry.name, formatCompact(entry.score), formatRate(entry.cps || 0), (entry.burst || 0) + "/s", when].forEach(function (value) {
        var td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  function setTopMsg(text, ok) {
    topMsg.textContent = text;
    topMsg.className = "top-msg " + (ok ? "ok" : "bad");
  }

  function submitScore(name) {
    var clean = name.trim().replace(/\s+/g, " ").replace(/[<>]/g, "").slice(0, 16);
    if (clean.length < 2) return Promise.resolve({ ok: false, text: tx("msgShort", "Use at least 2 characters.") });
    var nowScore = Math.floor(score);
    if (nowScore < 1) return Promise.resolve({ ok: false, text: tx("msgZero", "Get a score above zero first.") });
    return fetch(BOARD_URL + "/scores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: clean,
        score: nowScore,
        cps: currentCps(),
        burst: bestBurst
      })
    }).then(function (res) {
      return res.json().then(function (data) {
        return { ok: !!data.ok, text: boardMessage(data), name: clean };
      }, function () {
        return { ok: false, text: tx("msgOffline", "The top list is unavailable right now.") };
      });
    }).catch(function () {
      return { ok: false, text: tx("msgOffline", "The top list is unavailable right now.") };
    });
  }

  function openTop() {
    topPanel.hidden = false;
    setTopMsg("", true);
    renderTop();
    paint();
    topName.focus();
    loadBoard().then(function () {
      if (!topPanel.hidden) renderTop();
    }).catch(function () {
      if (!topPanel.hidden) setTopMsg(tx("msgOffline", "The top list is unavailable right now."), false);
    });
  }

  function closeTop() {
    topPanel.hidden = true;
  }

  function renderMute() {
    var btn = document.getElementById("muteBtn");
    btn.textContent = muted ? tx("soundOff", "Sound off") : tx("sound", "Sound");
    btn.setAttribute("aria-pressed", muted ? "true" : "false");
  }

  function toggleFullScreen() {
    if (!document.fullscreenElement) {
      var request = shellEl.requestFullscreen || shellEl.webkitRequestFullscreen || shellEl.mozRequestFullScreen || shellEl.msRequestFullscreen;
      if (request) request.call(shellEl);
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }

  buildShop();
  try { muted = localStorage.getItem(MUTE_KEY) === "1"; } catch (err) {}
  renderMute();
  loadGame();
  items.forEach(refreshDesc);
  paint();

  shellEl.addEventListener("pointerenter", function () { pointerInside = true; });
  shellEl.addEventListener("pointerleave", function () { pointerInside = false; });

  barEl.addEventListener("pointerdown", function (event) {
    if (event.button != null && event.button !== 0) return;
    registerClick(event.clientX, event.clientY);
    barEl.classList.add("is-down");
  });
  window.addEventListener("pointerup", function () { barEl.classList.remove("is-down"); });

  window.addEventListener("keydown", function (event) {
    if (event.code !== "Space" && event.key !== " ") {
      if (event.key === "Escape") closeTop();
      return;
    }
    if (event.repeat || !gameActive()) return;
    event.preventDefault();
    registerClick();
    barEl.classList.add("is-down");
  });
  window.addEventListener("keyup", function (event) {
    if (event.code === "Space" || event.key === " ") barEl.classList.remove("is-down");
  });

  document.getElementById("topBtn").addEventListener("click", openTop);
  document.getElementById("topClose").addEventListener("click", closeTop);
  document.getElementById("topForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var button = event.currentTarget.querySelector("button");
    if (button) button.disabled = true;
    submitScore(topName.value).then(function (result) {
      setTopMsg(result.text, result.ok);
      if (!result.ok) return;
      youName = result.name;
      return loadBoard().then(renderTop);
    }).catch(function () {
      setTopMsg(tx("msgOffline", "The top list is unavailable right now."), false);
    }).then(function () {
      if (button) button.disabled = false;
    });
  });
  topName.addEventListener("input", function () { setTopMsg("", true); });
  document.getElementById("muteBtn").addEventListener("click", function () {
    muted = !muted;
    renderMute();
    try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch (err) {}
  });
  document.getElementById("resetBtn").addEventListener("click", function () {
    if (!window.confirm(tx("resetConfirm", "Reset all progress? The top list stays."))) return;
    try { localStorage.removeItem(SAVE_KEY); } catch (err) {}
    window.location.reload();
  });
  var fsBtn = document.querySelector(".fullscreen-button");
  if (fsBtn) fsBtn.addEventListener("click", toggleFullScreen);
  window.addEventListener("pagehide", saveGame);

  setInterval(function () {
    var now = performance.now();
    var dt = Math.min(0.5, (now - lastTick) / 1000);
    lastTick = now;
    var cps = currentCps();
    score += cps * dt;
    if (cps >= 20 && topPanel.hidden && rainCount < 16 && Math.random() < Math.min(0.45, cps / 8000)) spawnRain();
    paint();
  }, 100);
  setInterval(saveGame, 2000);
})();
