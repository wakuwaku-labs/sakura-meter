/* =========================================================================
 * サクラメーター app.js
 * UI描画 / デモモード / Google Maps Platform 連携
 *
 * 実店舗検索には3つのモードがある:
 *   - "shared" (既定): Cloudflare Worker(代理サーバー)経由。訪問者は
 *     何も設定せずに使える。運営者のAPIキーはWorker側に隠蔽されており、
 *     月間利用回数もWorker側で完全にブロックされるため、運営者に
 *     想定外の課金が発生することはない。
 *   - "own" (任意・上級者向け): 自分のAPIキーを設定画面から登録すると、
 *     共有の無料枠を消費せず、地図プレビューも使えるようになる。
 *   - "demo": Workerが利用できない場合や、架空データのみのデモ配布版
 *     (window.SAKURA_DEMO_ONLY = true)で使われる。
 * ========================================================================= */

(() => {
  "use strict";

  const KEY_STORAGE = "sakura_meter_api_key";
  const DEMO_ONLY = typeof window !== "undefined" && window.SAKURA_DEMO_ONLY === true;
  const WORKER_BASE =
    (typeof window !== "undefined" && window.SAKURA_WORKER_URL) ||
    "https://sakura-meter-proxy.sakura-meter-proxy.workers.dev";

  const state = {
    mode: "demo",          // "shared" | "own" | "demo"
    places: [],            // 正規化済み: {id,name,genre,area,address,rating,userRatingCount,priceLevel,reviews?,gmapsUri?,location?,_live?,_shared?}
    selectedId: null,
    map: null,
    markers: [],
    mapsReady: false,
    ownKeyError: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  /* ---------------- 初期化 ---------------- */
  document.addEventListener("DOMContentLoaded", async () => {
    setupModals();

    if (DEMO_ONLY) {
      /* 共有用デモ版: APIキー設定UIを取り除く */
      document.querySelectorAll('[data-modal="settings"]').forEach((el) => el.remove());
      const settingsModal = document.getElementById("modal-settings");
      if (settingsModal) settingsModal.remove();
      state.mode = "demo";
    } else {
      setupSettings();
      const ownKey = localStorage.getItem(KEY_STORAGE);
      if (ownKey) {
        renderModeBanner("loading");
        const ok = await loadGoogleMaps(ownKey);
        if (ok) {
          state.mode = "own";
        } else {
          state.mode = "shared";
          state.ownKeyError = "保存されているAPIキーでの接続に失敗しました。共有の無料枠でそのまま利用できます。";
        }
      } else {
        state.mode = "shared";
      }
    }

    setupSearch();
    renderModeBanner(null, state.ownKeyError);

    if (state.mode === "demo") {
      state.places = DEMO_PLACES.map(normalizeDemoPlace);
      renderResults("デモ店舗一覧(架空データ)");
    }
  });

  function normalizeDemoPlace(p) {
    return { ...p, _live: false };
  }

  /* ---------------- モードバナー ---------------- */
  function renderModeBanner(override, errorMsg) {
    const el = $("#mode-banner");
    if (override === "loading") {
      el.innerHTML = `<span class="mode-chip live">Google連携</span><span>保存済みのAPIキーを確認しています…</span>`;
      return;
    }
    if (state.mode === "own") {
      el.innerHTML = `
        <span class="mode-chip live">Google連携中(自分のキー)</span>
        <span>あなた専用のAPIキーで、Googleマップの実データを検索・分析します。</span>
        <button class="linklike" type="button" data-modal="settings">設定</button>`;
    } else if (state.mode === "shared") {
      el.innerHTML = `
        <span class="mode-chip live">Google連携中</span>
        <span>設定不要で、誰でも実店舗を検索・分析できます(共有の無料枠を利用)。</span>
        ${DEMO_ONLY ? "" : `<button class="linklike" type="button" data-modal="settings">設定</button>`}`;
    } else {
      el.innerHTML = `
        <span class="mode-chip demo">デモモード</span>
        <span>架空の店舗データで動作中です(実在の店舗ではありません)。</span>
        ${DEMO_ONLY ? "" : `<button class="linklike" type="button" data-modal="settings">設定</button>`}`;
    }
    if (errorMsg) {
      const div = document.createElement("div");
      div.className = "status-line error";
      div.textContent = errorMsg;
      el.appendChild(div);
    }
    bindModalButtons(el);
  }

  function showBannerNotice(msg) {
    const el = $("#mode-banner");
    const div = document.createElement("div");
    div.className = "status-line error";
    div.textContent = msg;
    el.appendChild(div);
  }

  /* ---------------- 検索 ---------------- */
  function setupSearch() {
    $("#search-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = $("#search-input").value.trim();
      if (state.mode === "own") {
        await liveSearchOwn(q);
      } else if (state.mode === "shared") {
        await liveSearchShared(q);
      } else {
        demoSearch(q);
      }
    });
  }

  function demoSearch(q) {
    const all = DEMO_PLACES.map(normalizeDemoPlace);
    if (!q) {
      state.places = all;
    } else {
      const tokens = q.split(/[\s　]+/).filter(Boolean);
      state.places = all.filter((p) => {
        const hay = `${p.name} ${p.genre} ${p.area} ${p.address}`;
        return tokens.every((t) => hay.includes(t));
      });
    }
    state.selectedId = null;
    renderResults(q ? `「${q}」のデモ検索結果` : "デモ店舗一覧(架空データ)");
    renderPlaceholder();
  }

  /* ---- 共有Worker経由の検索(既定・訪問者は設定不要) ---- */
  async function liveSearchShared(q) {
    if (!q) {
      renderResultsMessage("検索キーワードを入力してください(例: 渋谷 焼肉)。");
      return;
    }
    renderResultsMessage("Googleマップを検索しています…", true);
    try {
      const res = await fetch(`${WORKER_BASE}/search?q=${encodeURIComponent(q)}`);
      const data = await res.json().catch(() => ({}));
      if (res.status === 429 && data.error === "quota_exceeded") {
        demoSearch(q);
        $("#results-title").textContent = `「${q}」のデモ検索結果(無料枠上限のため)`;
        showBannerNotice(data.message || "今月の無料検索枠の上限に達しました。");
        return;
      }
      if (!res.ok) {
        throw new Error((data && data.message) || `検索に失敗しました(HTTP ${res.status})。`);
      }
      state.places = (data.places || []).map(normalizeSharedSearchPlace);
      state.selectedId = null;
      renderResults(`「${q}」の検索結果`);
      renderPlaceholder();
    } catch (err) {
      console.error(err);
      renderResultsMessage("検索に失敗しました。しばらくしてからもう一度お試しください。");
    }
  }

  function normalizeSharedSearchPlace(pl) {
    return {
      id: pl.id,
      name: (pl.displayName && pl.displayName.text) || "(名称不明)",
      genre: "",
      area: "",
      address: pl.formattedAddress || "",
      rating: pl.rating ?? null,
      userRatingCount: pl.userRatingCount ?? 0,
      priceLevel: normalizePriceLevel(pl.priceLevel),
      location: pl.location ? { lat: pl.location.latitude, lng: pl.location.longitude } : null,
      _live: true,
      _shared: true,
    };
  }

  /* ---- 自分のAPIキー経由の検索(任意・上級者向け) ---- */
  async function liveSearchOwn(q) {
    if (!q) {
      renderResultsMessage("検索キーワードを入力してください(例: 渋谷 焼肉)。");
      return;
    }
    renderResultsMessage("Googleマップを検索しています…", true);
    try {
      const { Place } = await google.maps.importLibrary("places");
      const { places } = await Place.searchByText({
        textQuery: q,
        includedType: "restaurant",
        language: "ja",
        region: "jp",
        maxResultCount: 20,
        fields: [
          "displayName", "formattedAddress", "location",
          "rating", "userRatingCount", "priceLevel", "id",
        ],
      });
      state.places = (places || []).map((pl) => ({
        id: pl.id,
        name: pl.displayName || "(名称不明)",
        genre: "",
        area: "",
        address: pl.formattedAddress || "",
        rating: pl.rating ?? null,
        userRatingCount: pl.userRatingCount ?? 0,
        priceLevel: normalizePriceLevel(pl.priceLevel),
        location: pl.location || null,
        _placeObj: pl,
        _live: true,
      }));
      state.selectedId = null;
      renderResults(`「${q}」の検索結果`);
      renderPlaceholder();
      renderMap();
    } catch (err) {
      console.error(err);
      renderResultsMessage("検索に失敗しました。APIキーの権限(Places API (New) の有効化)や利用上限をご確認ください。");
    }
  }

  function normalizePriceLevel(v) {
    if (v == null) return null;
    if (typeof v === "number") return v;
    const map = { FREE: 0, INEXPENSIVE: 1, MODERATE: 2, EXPENSIVE: 3, VERY_EXPENSIVE: 4 };
    const key = String(v).replace("PRICE_LEVEL_", "");
    return map[key] ?? null;
  }

  /* ---------------- 結果リスト ---------------- */
  function renderResultsMessage(msg, loading) {
    $("#result-list").innerHTML = `<li class="empty-note${loading ? " loading" : ""}">${esc(msg)}</li>`;
  }

  function renderResults(title) {
    $("#results-title").textContent = title || "検索結果";
    $("#results-attribution").textContent =
      state.mode === "shared" || state.mode === "own" ? "検索結果: Google マップ提供" : "架空のサンプルデータ";

    const list = $("#result-list");
    if (state.places.length === 0) {
      renderResultsMessage("該当する店舗が見つかりませんでした。キーワードを変えてお試しください。");
      return;
    }
    list.innerHTML = state.places
      .map((p) => {
        const stars = p.rating != null ? starString(p.rating) : "";
        const price = p.priceLevel ? "・" + "¥".repeat(p.priceLevel) : "";
        return `
        <li>
          <button class="result-card${p.id === state.selectedId ? " selected" : ""}" data-id="${esc(p.id)}" type="button">
            <p class="result-name">${esc(p.name)}</p>
            <div class="result-meta">
              ${p.rating != null ? `<span class="stars" aria-hidden="true">${stars}</span><span>${p.rating.toFixed(1)}</span>` : "<span>評価なし</span>"}
              <span class="result-count">(${p.userRatingCount ?? 0}件)</span>
              ${p.genre ? `<span>${esc(p.genre)}</span>` : ""}${price ? `<span>${price.slice(1)}</span>` : ""}
            </div>
            <div class="result-meta">${esc(p.address)}</div>
          </button>
        </li>`;
      })
      .join("");

    list.querySelectorAll(".result-card").forEach((btn) => {
      btn.addEventListener("click", () => selectPlace(btn.dataset.id));
    });
  }

  function starString(rating) {
    const full = Math.round(rating);
    return "★".repeat(full) + "☆".repeat(5 - full);
  }

  /* ---------------- 店舗選択 → 分析 ---------------- */
  async function selectPlace(id) {
    const place = state.places.find((p) => p.id === id);
    if (!place) return;
    state.selectedId = id;
    renderResults($("#results-title").textContent);

    if (place._live && !place.reviews && !place.quotaExceeded && !place._fetchingReviews) {
      place._fetchingReviews = true;
      $("#analysis-panel").innerHTML = `<div class="loading">クチコミを取得して分析しています…</div>`;
      try {
        if (place._shared) {
          const res = await fetch(`${WORKER_BASE}/details/${encodeURIComponent(id)}`);
          const data = await res.json().catch(() => ({}));
          if (res.status === 429 && data.error === "quota_exceeded") {
            place.quotaExceeded = true;
            place.quotaMessage = data.message || "今月の無料分析枠の上限に達しました。";
          } else if (!res.ok) {
            throw new Error((data && data.message) || `取得に失敗しました(HTTP ${res.status})。`);
          } else {
            place.gmapsUri = data.googleMapsUri || null;
            place.reviews = (data.reviews || []).map(normalizeSharedReview);
            if (data.rating != null) place.rating = data.rating;
            if (data.userRatingCount != null) place.userRatingCount = data.userRatingCount;
          }
        } else {
          await place._placeObj.fetchFields({ fields: ["reviews", "googleMapsURI"] });
          place.gmapsUri = place._placeObj.googleMapsURI || null;
          place.reviews = (place._placeObj.reviews || []).map(normalizeLiveReview);
        }
      } catch (err) {
        console.error(err);
        place.reviews = [];
        place.reviewFetchError = true;
      } finally {
        place._fetchingReviews = false;
      }
    }

    /* 選択後の非同期取得中に他の店舗が選ばれていたら、古い応答は描画しない */
    if (state.selectedId !== id) return;

    if (place.quotaExceeded) {
      renderQuotaExceededPanel(place);
      return;
    }

    try {
      const peers = state.places.filter((p) => p.id !== id);
      const result = Analyzer.analyze(place, peers);
      renderAnalysis(place, result);
    } catch (err) {
      console.error(err);
      $("#analysis-panel").innerHTML = `<div class="panel-placeholder">分析中にエラーが発生しました。お手数ですが、もう一度店舗を選び直してください。</div>`;
      return;
    }
    if (window.matchMedia("(max-width: 900px)").matches) {
      $("#analysis-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function renderQuotaExceededPanel(place) {
    $("#analysis-panel").innerHTML = `
      <header class="place-header"><h2>${esc(place.name)}</h2></header>
      <div class="panel-placeholder">
        ${esc(place.quotaMessage)}<br>
        お急ぎの場合は、右上「設定」からご自身のAPIキーを登録すると、この上限に関係なくすぐに分析できます。
      </div>`;
  }

  function normalizeSharedReview(r) {
    const text = (r.text && r.text.text) || (r.originalText && r.originalText.text) || "";
    return {
      rating: r.rating ?? null,
      text,
      publishTime: r.publishTime || null,
      author: (r.authorAttribution && r.authorAttribution.displayName) || "Googleユーザー",
      relative: r.relativePublishTimeDescription || "",
    };
  }

  function normalizeLiveReview(r) {
    let text = r.text;
    if (text && typeof text === "object") text = text.text ?? "";
    let publishTime = r.publishTime;
    if (publishTime instanceof Date) publishTime = publishTime.toISOString();
    return {
      rating: r.rating ?? null,
      text: text || "",
      publishTime: publishTime || null,
      author: (r.authorAttribution && r.authorAttribution.displayName) || "Googleユーザー",
      relative: r.relativePublishTimeDescription || "",
    };
  }

  /* ---------------- 分析パネル描画 ---------------- */
  const BAND_CHIP_CLASS = {
    low: "band-low-chip",
    mild: "band-mild-chip",
    caution: "band-caution-chip",
    strong: "band-strong-chip",
  };
  const BAND_COLOR_VAR = {
    low: "var(--band-low)",
    mild: "var(--band-mild)",
    caution: "var(--band-caution)",
    strong: "var(--band-strong)",
  };

  function renderAnalysis(place, result) {
    const panel = $("#analysis-panel");
    const r = result;

    const headerHtml = `
      <header class="place-header">
        <h2>${esc(place.name)}</h2>
        <div class="place-sub">
          ${place.rating != null ? `<span><span class="stars" aria-hidden="true">${starString(place.rating)}</span> ${place.rating.toFixed(1)}(${place.userRatingCount}件)</span>` : ""}
          ${place.genre ? `<span>${esc(place.genre)}</span>` : ""}
          <span>${esc(place.address)}</span>
          ${place.gmapsUri ? `<a href="${esc(place.gmapsUri)}" target="_blank" rel="noopener">Googleマップで見る</a>` : ""}
        </div>
        ${place._live ? "" : `<span class="demo-flag">デモデータ — 実在の店舗ではありません</span>`}
      </header>`;

    if (!r.analyzable) {
      panel.innerHTML = `
        ${headerHtml}
        <div class="panel-placeholder">
          この店舗は分析に必要なデータ(評価・クチコミ)が不足しているため、スコアを算出できません。<br>
          クチコミが増えてから改めてお試しください。
        </div>
        ${disclaimerHtml()}`;
      return;
    }

    const circumference = 2 * Math.PI * 80;
    const dash = (r.score / 100) * circumference;
    const bandColor = BAND_COLOR_VAR[r.band.key];

    const gaugeHtml = `
      <div class="score-area">
        <div class="gauge-wrap" role="img" aria-label="サクラ的パターン一致度 ${r.score}%(${r.band.label})">
          <svg viewBox="0 0 190 190">
            <circle class="gauge-track" cx="95" cy="95" r="80" fill="none" stroke-width="14"></circle>
            <circle class="gauge-value" cx="95" cy="95" r="80" fill="none" stroke-width="14"
              stroke="${bandColor}" stroke-linecap="round"
              stroke-dasharray="${circumference.toFixed(1)}"
              stroke-dashoffset="${circumference.toFixed(1)}"></circle>
          </svg>
          <div class="gauge-center">
            <span class="gauge-number" style="color:${bandColor}">${r.score}<small>%</small></span>
            <span class="gauge-caption">参考値</span>
          </div>
        </div>
        <div class="score-side">
          <p class="score-title">サクラ的パターン一致度(参考値)</p>
          <span class="band-chip ${BAND_CHIP_CLASS[r.band.key]}">${r.band.label}</span>
          <p class="band-summary">${esc(r.band.summary)}</p>
          <div class="confidence-row">
            <span>信頼度:</span>
            <span class="conf-chip ${r.confidence.level}">${r.confidence.label}</span>
            <span>${esc(r.confidence.reasons.join(" / "))}</span>
          </div>
          <button class="method-link" type="button" data-modal="method">この数値の算出方法を見る</button>
          ${r.convergence && r.convergence.note ? `<p class="relief-note">${esc(r.convergence.note)}</p>` : ""}
          ${r.relief ? `<p class="relief-note">${esc(r.relief.note)}</p>` : ""}
        </div>
      </div>`;

    const signalsHtml = `
      <section class="signals-section">
        <h3>シグナル内訳 <span class="section-note">クリックで根拠と代替説明を表示</span></h3>
        <div class="signal-list">
          ${r.signals.map(signalItemHtml).join("")}
        </div>
      </section>`;

    const checklistHtml = checklistSectionHtml(r);
    const distHtml = distributionSectionHtml(place, r);

    const reviews = place.reviews || [];
    const reviewsHtml = `
      <section class="reviews-section">
        <h3>分析対象のクチコミ
          <span class="section-note">${place._live
            ? `Google マップより(公式APIが返す関連度順・最大5件)`
            : `架空のサンプルクチコミ(${reviews.length}件)`}</span>
        </h3>
        ${place.reviewFetchError ? `<p class="status-line error">クチコミの取得に失敗しました。</p>` : ""}
        <div class="review-list">
          ${reviews.length === 0 ? `<p class="empty-note">表示できるクチコミがありません。</p>` : reviews.map(reviewItemHtml).join("")}
        </div>
      </section>`;

    panel.innerHTML = headerHtml + gaugeHtml + checklistHtml + signalsHtml +
                      distHtml + reviewsHtml + disclaimerHtml();
    bindModalButtons(panel);
    bindDistributionForm(place);

    /* ゲージのアニメーション(reduced-motion環境ではCSS側で無効化) */
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const c = panel.querySelector(".gauge-value");
        if (c) c.style.strokeDashoffset = (circumference - dash).toFixed(1);
      });
    });
  }

  /* ---- チェックリスト(4軸12項目) ---------------------------------- */
  const CHECK_STATE_META = {
    hit:     { mark: "●", cls: "hit",     label: "該当" },
    clear:   { mark: "—", cls: "clear",   label: "該当なし" },
    unknown: { mark: "?", cls: "unknown", label: "判定不可" },
  };

  function checklistSectionHtml(r) {
    const cl = r.checklist;
    if (!cl || cl.items.length === 0) return "";

    /* 軸ごとにまとめる(表示順は Analyzer の並びを保つ) */
    const groups = [];
    cl.items.forEach((it) => {
      let g = groups.find((x) => x.axis === it.axis);
      if (!g) groups.push((g = { axis: it.axis, items: [] }));
      g.items.push(it);
    });

    const verdict = cl.hits >= 3
      ? `<strong>${cl.hits}項目に該当</strong>しています。実務上は「3項目以上でサクラの疑いが高い」とされる目安を超えています。`
      : cl.hits === 0
        ? `該当した項目は<strong>ありません</strong>。`
        : `該当は<strong>${cl.hits}項目</strong>で、目安とされる3項目には達していません。`;

    return `
      <section class="checklist-section">
        <h3>チェックリスト
          <span class="section-note">判定できた${cl.judged}項目中 ${cl.hits}項目に該当</span>
        </h3>
        <p class="checklist-verdict">${verdict} 1つの兆候だけでは判断できません。重なりの多さで読んでください。</p>
        <div class="checklist-groups">
          ${groups.map((g) => `
            <div class="checklist-group">
              <h4>${esc(g.axis)}</h4>
              <ul>
                ${g.items.map((it) => {
                  const m = CHECK_STATE_META[it.state];
                  return `<li class="check-item ${m.cls}">
                    <span class="check-mark" aria-hidden="true">${m.mark}</span>
                    <span class="check-body">
                      <span class="check-label">${esc(it.label)}</span>
                      <span class="check-detail">${esc(it.detail)}</span>
                    </span>
                    <span class="visually-hidden">${m.label}</span>
                  </li>`;
                }).join("")}
              </ul>
            </div>`).join("")}
        </div>
      </section>`;
  }

  /* ---- 星の分布の手入力(精度向上オプション) ------------------------ */
  const DIST_STARS = [5, 4, 3, 2, 1];

  /* 平均評価から、それらしい初期分布を生成してスライダーの出発点にする */
  function seedDistribution(rating) {
    const R = rating == null ? 4.0 : rating;
    const w = {};
    DIST_STARS.forEach((k) => {
      w[k] = Math.exp(-Math.abs(k - R) * 1.5);
    });
    w[1] = Math.max(w[1], 0.03); // ★1は常に少し存在するのが普通
    const max = Math.max(...DIST_STARS.map((k) => w[k]));
    const out = {};
    DIST_STARS.forEach((k) => (out[k] = Math.max(1, Math.round((w[k] / max) * 100))));
    return out;
  }

  function distributionSectionHtml(place, r) {
    const count = place.userRatingCount || 0;
    if (count < 20) {
      return `
        <section class="dist-section">
          <h3>星の分布 <span class="section-note">この店舗では利用できません</span></h3>
          <p class="dist-lede">総クチコミ数が${count}件と少なく、分布の形から判断すると誤差が大きすぎるため、この入力は無効にしています(20件以上で利用できます)。</p>
        </section>`;
    }
    const applied = place.ratingDistribution || null;
    const vals = applied ? normalizeToSliders(applied) : seedDistribution(place.rating);

    return `
      <section class="dist-section">
        <details class="dist-details"${applied ? "" : " open"}>
          <summary>
            <span class="dist-title">星の分布を入力して精度を上げる</span>
            <span class="dist-state ${applied ? "on" : "off"}">${applied ? "入力済み — 分析に反映中" : "未入力 — 1つのシグナルが対象外です"}</span>
          </summary>
          <div class="dist-body">
            <p class="dist-lede">
              Googleの公式APIは<strong>星ごとの件数(分布)を提供していません</strong>。
              Googleマップの店舗ページに出ている棒グラフを見ながら、5本のバーの長さを近づけてください。
              「★5と★1に割れて中間が凹むお椀型」は、実証研究で偽レビューに特徴的とされる形です。
            </p>
            <div class="dist-rows">
              ${DIST_STARS.map((k) => `
                <label class="dist-row">
                  <span class="dist-star">★${k}</span>
                  <input type="range" min="0" max="100" step="1" value="${vals[k]}" data-star="${k}">
                  <output class="dist-out" data-out="${k}">${vals[k]}</output>
                </label>`).join("")}
            </div>
            <div class="dist-readout" id="dist-readout"></div>
            <div class="dist-actions">
              <button class="btn-primary" type="button" id="dist-apply">この分布で再分析</button>
              ${applied ? `<button class="btn-secondary" type="button" id="dist-clear">入力を取り消す</button>` : ""}
            </div>
            <p class="dist-note">入力値はこの画面の中だけで使われ、保存も送信もされません。</p>
          </div>
        </details>
      </section>`;
  }

  /* 保存済みの件数分布を 0-100 のスライダー値に戻す */
  function normalizeToSliders(dist) {
    const raw = {};
    DIST_STARS.forEach((k) => (raw[k] = Number(dist[k] ?? 0)));
    const max = Math.max(...DIST_STARS.map((k) => raw[k]), 1);
    const out = {};
    DIST_STARS.forEach((k) => (out[k] = Math.round((raw[k] / max) * 100)));
    return out;
  }

  function bindDistributionForm(place) {
    const panel = $("#analysis-panel");
    const sliders = [...panel.querySelectorAll('.dist-row input[type="range"]')];
    if (sliders.length === 0) return;

    const readCurrent = () => {
      const d = {};
      sliders.forEach((el) => (d[el.dataset.star] = Number(el.value)));
      return d;
    };

    const refresh = () => {
      const d = readCurrent();
      sliders.forEach((el) => {
        const out = panel.querySelector(`[data-out="${el.dataset.star}"]`);
        if (out) out.textContent = el.value;
      });
      const total = DIST_STARS.reduce((s, k) => s + d[k], 0);
      const readout = panel.querySelector("#dist-readout");
      if (!readout) return;
      if (total <= 0) {
        readout.innerHTML = `<span class="dist-warn">すべて0では分布になりません。バーの長さを設定してください。</span>`;
        return;
      }
      const mean = DIST_STARS.reduce((s, k) => s + d[k] * k, 0) / total;
      const p5 = (d[5] / total) * 100;
      const actual = place.rating;
      const diff = actual != null ? mean - actual : null;
      const ok = diff != null && Math.abs(diff) <= 0.1;
      readout.innerHTML = `
        <span>この分布から計算した平均: <strong>${mean.toFixed(2)}</strong></span>
        ${actual != null ? `<span>実際の表示評価: <strong>${actual.toFixed(1)}</strong></span>` : ""}
        ${diff != null
          ? `<span class="dist-fit ${ok ? "ok" : "off"}">${ok
              ? "一致しています(この分布で問題ありません)"
              : `${diff > 0 ? "高すぎます" : "低すぎます"}(差 ${diff.toFixed(2)}) — バーの長さを調整してください`}</span>`
          : ""}
        <span class="dist-p5">★5の割合: ${p5.toFixed(1)}%</span>`;
    };

    sliders.forEach((el) => el.addEventListener("input", refresh));
    refresh();

    const applyBtn = panel.querySelector("#dist-apply");
    if (applyBtn) {
      applyBtn.addEventListener("click", () => {
        const d = readCurrent();
        const total = DIST_STARS.reduce((s, k) => s + d[k], 0);
        if (total <= 0) return;
        /* スライダーの相対値を、実際の総クチコミ数に合わせた件数へ変換 */
        const n = place.userRatingCount || 0;
        const counts = {};
        DIST_STARS.forEach((k) => (counts[k] = Math.round((d[k] / total) * n)));
        place.ratingDistribution = counts;
        reanalyze(place);
      });
    }
    const clearBtn = panel.querySelector("#dist-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        delete place.ratingDistribution;
        reanalyze(place);
      });
    }
  }

  function reanalyze(place) {
    const peers = state.places.filter((p) => p.id !== place.id);
    try {
      renderAnalysis(place, Analyzer.analyze(place, peers));
    } catch (err) {
      console.error(err);
    }
  }

  function signalItemHtml(s) {
    if (!s.included) {
      const baseWeightPct = Math.round(s.weight * 100);
      return `
      <details class="signal-item">
        <summary class="signal-summary">
          <span class="signal-name">${esc(s.label)}<span class="signal-weight"><span class="axis-chip">${esc(s.axis)}</span>本来の重み${baseWeightPct}%(今回は対象外)</span></span>
          <span class="signal-bar-track"><span class="signal-bar-fill" style="width:0%"></span></span>
          <span class="signal-score na">対象外</span>
        </summary>
        <div class="signal-body">
          <p><span class="tag">このシグナルが見るもの</span>${esc(s.description)}</p>
          <p><span class="tag">対象外の理由</span>${esc(s.evidence)}</p>
        </div>
      </details>`;
    }
    /* 表示する重みは、除外シグナル分を再配分した後の「実際にスコアへ
     * 効いた割合」(effectiveWeight)。静的な既定重みではない。 */
    const weightPct = Math.round(s.effectiveWeight * 100);
    return `
    <details class="signal-item">
      <summary class="signal-summary">
        <span class="signal-name">${esc(s.label)}<span class="signal-weight"><span class="axis-chip">${esc(s.axis)}</span>今回の寄与度${weightPct}%</span></span>
        <span class="signal-bar-track"><span class="signal-bar-fill" style="width:${s.score}%"></span></span>
        <span class="signal-score">${s.score}</span>
      </summary>
      <div class="signal-body">
        <p><span class="tag">このシグナルが見るもの</span>${esc(s.description)}</p>
        <p><span class="tag">この店舗での根拠</span>${esc(s.evidence)}</p>
        <p class="alt-box"><span class="tag">サクラ以外の可能性</span>${esc(s.altExplanation)}</p>
      </div>
    </details>`;
  }

  function reviewItemHtml(rv) {
    const date = rv.publishTime ? new Date(rv.publishTime) : null;
    const dateStr = date && !isNaN(date)
      ? `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
      : (rv.relative || "");
    const text = (rv.text || "").trim();
    return `
    <article class="review-item">
      <div class="review-head">
        <span class="review-author">${esc(rv.author)}</span>
        <span class="stars" aria-hidden="true">${starString(rv.rating || 0)}</span>
        <span>${esc(dateStr)}</span>
      </div>
      <p class="review-text${text ? "" : " empty"}">${text ? esc(text) : "(本文なし・星のみの投稿)"}</p>
    </article>`;
  }

  function disclaimerHtml() {
    return `
    <div class="result-disclaimer">
      <strong>ご利用にあたって</strong> —
      この結果は公開データからの統計的推定による参考値です。サクラ利用の事実を断定・証明するものではなく、
      話題化・開店直後など、サクラ以外の理由でも同様のパターンは生じます。
      店舗への誹謗中傷や営業妨害の目的での利用は固くお断りします。
      最終的には、クチコミ本文とお店そのものをご自身の目でお確かめください。
    </div>`;
  }

  function renderPlaceholder() {
    $("#analysis-panel").innerHTML = `
      <div class="panel-placeholder">
        <span class="petal-icon">❀</span>
        左のリストから店舗を選ぶと、クチコミの分析結果がここに表示されます。
      </div>`;
  }

  /* ---------------- Google Maps 読み込み(自分のAPIキーを使う場合のみ) ---------------- */
  function loadGoogleMaps(apiKey) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };

      /* 認証失敗(無効キーなど)時に Google が呼ぶグローバルフック */
      window.gm_authFailure = () => done(false);

      /* 公式ブートストラップローダー */
      ((g) => {
        var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary",
          q = "__ib__", m = document, b = window;
        b = b[c] || (b[c] = {});
        var d = b.maps || (b.maps = {}), r = new Set(),
          e = new URLSearchParams(),
          u = () => h || (h = new Promise(async (f, n) => {
            await (a = m.createElement("script"));
            e.set("libraries", [...r] + "");
            for (k in g) e.set(k.replace(/[A-Z]/g, (t) => "_" + t[0].toLowerCase()), g[k]);
            e.set("callback", c + ".maps." + q);
            a.src = "https://maps." + c + "apis.com/maps/api/js?" + e;
            d[q] = f;
            a.onerror = () => (h = n(Error(p + " could not load.")));
            a.nonce = m.querySelector("script[nonce]")?.nonce || "";
            m.head.append(a);
          }));
        d[l] ? console.warn(p + " only loads once. Ignoring:", g)
             : (d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)));
      })({ key: apiKey, v: "weekly", language: "ja", region: "JP" });

      Promise.all([
        google.maps.importLibrary("maps"),
        google.maps.importLibrary("places"),
        google.maps.importLibrary("marker"),
      ]).then(() => {
        state.mapsReady = true;
        done(true);
      }).catch((err) => {
        console.error(err);
        done(false);
      });

      setTimeout(() => done(false), 12000);
    });
  }

  async function renderMap() {
    if (!state.mapsReady) return;
    const withLoc = state.places.filter((p) => p.location);
    const mapEl = $("#map");
    if (withLoc.length === 0) { mapEl.classList.remove("visible"); return; }
    mapEl.classList.add("visible");

    const { Map } = await google.maps.importLibrary("maps");
    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

    if (!state.map) {
      state.map = new Map(mapEl, {
        center: withLoc[0].location,
        zoom: 14,
        mapId: "DEMO_MAP_ID",
        clickableIcons: false,
      });
    }
    state.markers.forEach((m) => (m.map = null));
    state.markers = [];

    const bounds = new google.maps.LatLngBounds();
    withLoc.forEach((p) => {
      const marker = new AdvancedMarkerElement({
        map: state.map,
        position: p.location,
        title: p.name,
      });
      marker.addListener("click", () => selectPlace(p.id));
      state.markers.push(marker);
      bounds.extend(p.location);
    });
    state.map.fitBounds(bounds, 40);
  }

  /* ---------------- モーダル ---------------- */
  function setupModals() {
    bindModalButtons(document);
    document.querySelectorAll(".modal-backdrop").forEach((bk) => {
      bk.addEventListener("click", (e) => { if (e.target === bk) closeModals(); });
      bk.querySelector(".modal-close").addEventListener("click", closeModals);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModals();
    });
  }

  function bindModalButtons(root) {
    root.querySelectorAll("[data-modal]").forEach((btn) => {
      if (btn._modalBound) return;
      btn._modalBound = true;
      btn.addEventListener("click", () => openModal(btn.dataset.modal));
    });
  }

  function openModal(name) {
    closeModals();
    const bk = $(`#modal-${name}`);
    if (bk) bk.classList.add("open");
  }

  function closeModals() {
    document.querySelectorAll(".modal-backdrop.open").forEach((bk) => bk.classList.remove("open"));
  }

  /* ---------------- 設定(任意・上級者向け) ---------------- */
  function setupSettings() {
    const input = $("#api-key-input");
    const status = $("#settings-status");
    input.value = localStorage.getItem(KEY_STORAGE) || "";

    $("#save-key-btn").addEventListener("click", () => {
      const key = input.value.trim();
      if (!key) {
        status.textContent = "APIキーを入力してください。";
        status.className = "status-line error";
        return;
      }
      localStorage.setItem(KEY_STORAGE, key);
      status.textContent = "保存しました。ページを再読み込みして有効化します…";
      status.className = "status-line ok";
      setTimeout(() => location.reload(), 700);
    });

    $("#clear-key-btn").addEventListener("click", () => {
      localStorage.removeItem(KEY_STORAGE);
      input.value = "";
      status.textContent = "キーを削除しました。共有の無料枠に戻ります…";
      status.className = "status-line ok";
      setTimeout(() => location.reload(), 700);
    });
  }
})();
