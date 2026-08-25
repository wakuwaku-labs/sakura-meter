/* =========================================================================
 * サクラメーター Cloudflare Worker (代理サーバー)
 *
 * 目的: Google Places API (New) の APIキーをブラウザに一切露出させず、
 *       月間の利用回数をこのWorker側で完全にブロックすることで、
 *       運営者の課金額を確実に 0円 に保つ。
 *
 * エンドポイント:
 *   GET /search?q=<検索語>        … Text Search (New) の代理
 *   GET /details/:placeId         … Place Details (New) の代理(クチコミ含む)
 *
 * 環境変数(wrangler secret): GOOGLE_MAPS_API_KEY
 * KVバインディング: QUOTA_KV
 * ========================================================================= */

const ALLOWED_ORIGINS = [
  "https://wakuwaku-labs.github.io",
  "http://localhost:8000",
  "http://localhost:8642",
];

/* 無料枠(各SKU月1,000件)に対し、余裕を持たせた月間上限 */
const MONTHLY_CAPS = {
  search: 900,
  details: 900,
};

const SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
].join(",");

const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "rating",
  "userRatingCount",
  "priceLevel",
  "reviews",
  "googleMapsUri",
].join(",");

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* KVで月間カウンタをチェック&加算。上限超過なら false を返す。
 * (同時アクセスでの多少の誤差は許容 — 上限より十分小さい余裕(100件)で吸収) */
async function tryConsumeQuota(kv, kind) {
  const key = `${kind}:${currentMonthKey()}`;
  const current = parseInt((await kv.get(key)) || "0", 10);
  if (current >= MONTHLY_CAPS[kind]) return { ok: false, current };
  await kv.put(key, String(current + 1), { expirationTtl: 60 * 60 * 24 * 45 });
  return { ok: true, current: current + 1 };
}

async function handleSearch(url, env, origin) {
  const q = url.searchParams.get("q");
  if (!q) return json({ error: "bad_request", message: "検索語(q)を指定してください。" }, 400, origin);

  const quota = await tryConsumeQuota(env.QUOTA_KV, "search");
  if (!quota.ok) {
    return json(
      { error: "quota_exceeded", message: "今月の無料検索枠の上限に達しました。来月また実店舗検索が利用できます。" },
      429,
      origin
    );
  }

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": SEARCH_FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: q,
      includedType: "restaurant",
      languageCode: "ja",
      regionCode: "JP",
      maxResultCount: 20,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return json({ error: "upstream_error", message: "Google Places APIへの問い合わせに失敗しました。", detail: text.slice(0, 500) }, 502, origin);
  }
  const data = await res.json();
  return json({ places: data.places || [] }, 200, origin);
}

async function handleDetails(placeId, env, origin) {
  if (!placeId) return json({ error: "bad_request", message: "店舗IDが指定されていません。" }, 400, origin);

  const quota = await tryConsumeQuota(env.QUOTA_KV, "details");
  if (!quota.ok) {
    return json(
      { error: "quota_exceeded", message: "今月の無料分析枠の上限に達しました。来月また実店舗の分析が利用できます。" },
      429,
      origin
    );
  }

  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": DETAILS_FIELD_MASK,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    return json({ error: "upstream_error", message: "Google Places APIへの問い合わせに失敗しました。", detail: text.slice(0, 500) }, 502, origin);
  }
  const data = await res.json();
  return json(data, 200, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405, origin);
    }

    if (url.pathname === "/search") {
      return handleSearch(url, env, origin);
    }
    const detailsMatch = url.pathname.match(/^\/details\/(.+)$/);
    if (detailsMatch) {
      return handleDetails(decodeURIComponent(detailsMatch[1]), env, origin);
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "sakura-meter-proxy" }, 200, origin);
    }
    return json({ error: "not_found" }, 404, origin);
  },
};
