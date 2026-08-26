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

/* 各SKUの無料枠に対し、余裕を持たせた月間上限。
 *
 * 呼び出しごとに消費されるSKUと、その月間無料枠(2026年8月時点):
 *   search  … Places API (New) Text Search Enterprise           月1,000件
 *   details … Places API (New) Place Details Enterprise         月1,000件
 *             (rating / reviews を含むため Enterprise 相当)
 *   detailsLegacy … Places API (Legacy) の1回の呼び出しで2つのSKUを消費
 *             - Places Details       (FC5C-DF28-543F) 月5,000件
 *             - Atmosphere Data      (D63D-5CC5-302A) 月1,000件  ← 実質の上限
 *             fields=reviews は Atmosphere Data に該当するため、
 *             効いてくるのは少ない方の1,000件。よって上限は900件とする。
 *
 * いずれもSKUごとに独立した無料枠なので、新着順の追加取得によって
 * 既存の検索・分析の枠が減ることはない。 */
const MONTHLY_CAPS = {
  search: 900,
  details: 900,
  detailsLegacy: 900,
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

/* ---------------------------------------------------------------------------
 * 新着順クチコミの取得 (Places API (Legacy))
 *
 * Places API (New) が返すクチコミは「関連度順」で最大5件のみ。投稿日時順で
 * は取得できず、これが本アプリの分析精度を最も強く縛っていた。
 *
 * Legacy の Place Details には reviews_sort=newest があり、投稿日時の新しい
 * 順に最大5件を返す。関連度順5件とマージすることで、
 *   - 真の直近投稿(集中しているか、途絶しているか)が測れる
 *   - 新しい低評価(攻撃レビューは新しい)が取得できる可能性が上がる
 *   - 実効サンプル数が最大10件に増える
 *
 * reviews_no_translations=true を付けて、機械翻訳ではなく投稿者が実際に
 * 書いた原文を受け取る(翻訳文は文体分析を壊すため)。
 *
 * Legacy が無効なプロジェクトや上限超過では null を返し、呼び出し側は
 * 関連度順のみで動作を続ける(機能低下であってエラーではない)。
 * ------------------------------------------------------------------------- */
async function fetchNewestReviews(placeId, env) {
  const quota = await tryConsumeQuota(env.QUOTA_KV, "detailsLegacy");
  if (!quota.ok) return { reviews: null, reason: "quota_exceeded" };

  const params = new URLSearchParams({
    place_id: placeId,
    fields: "reviews",
    reviews_sort: "newest",
    reviews_no_translations: "true",
    language: "ja",
    key: env.GOOGLE_MAPS_API_KEY,
  });

  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/details/json?${params}`
    );
    if (!res.ok) return { reviews: null, reason: `http_${res.status}` };
    const data = await res.json();
    /* 失敗しても分析自体は続行するが、理由は返す。完全にサイレントだと
     * 「Legacy を有効化したつもりが実は効いていない」状態に気づけない。
     * 代表的な原因:
     *   REQUEST_DENIED … Places API (Legacy) が未有効、またはAPIキーの
     *                     「APIの制限」に Places API が含まれていない
     *   OVER_QUERY_LIMIT … 上限超過 */
    if (data.status !== "OK") {
      return { reviews: null, reason: data.status || "unknown", detail: (data.error_message || "").slice(0, 200) };
    }
    if (!data.result || !data.result.reviews) {
      return { reviews: null, reason: "no_reviews" };
    }
    return { reviews: data.result.reviews.map(toNewShapeReview), reason: null };
  } catch (err) {
    return { reviews: null, reason: "fetch_failed" };
  }
}

/* Legacy のクチコミを Places API (New) の形に揃える。
 * こうしておくと、フロント側の正規化処理を分岐させずに済む。 */
function toNewShapeReview(r) {
  const iso = r.time ? new Date(r.time * 1000).toISOString() : null;
  const body = r.text || "";
  /* Legacy は translated / original_language を返してくれる。
   * reviews_no_translations=true なので body は原文のはず。 */
  const translated = r.translated === true;
  return {
    rating: r.rating ?? null,
    text: { text: body, languageCode: r.language || "" },
    originalText: { text: body, languageCode: r.original_language || r.language || "" },
    publishTime: iso,
    relativePublishTimeDescription: r.relative_time_description || "",
    authorAttribution: {
      displayName: r.author_name || "",
      uri: r.author_url || "",
      photoUri: r.profile_photo_url || "",
    },
    _translated: translated,
    _source: "newest",
  };
}

/* 関連度順と新着順をマージして重複を除く。
 *
 * 重複判定を誤ると被害が大きい。同じクチコミが2件残ると、本文が完全一致
 * するため類似度が100%になり「コピペされたクチコミ」として誤検知され、
 * 投稿日時も同一になるため「0日間に集中」というバーストまで誤検出する。
 *
 * 注意すべき形式差:
 *   Places API (New) の publishTime は RFC3339 で最大9桁の小数秒を持ちうる
 *     例) 2026-06-01T10:20:30.045123456Z
 *   Legacy の time は Unix秒なので、変換すると必ず .000Z になる
 *     例) 2026-06-01T10:20:30.000Z
 * そのまま文字列比較すると同一クチコミが別物と判定されるため、
 * 秒単位に丸めてから比較する。
 *
 * さらに保険として、投稿者名+本文でも突き合わせる(APIによって日時が
 * 微妙にずれる場合に備える)。 */
function mergeReviews(relevant, newest) {
  /* 秒精度に丸めた時刻。小数秒の有無による取りこぼしを防ぐ */
  const secondsOf = (iso) => {
    const t = Date.parse(iso || "");
    return isNaN(t) ? "" : String(Math.floor(t / 1000));
  };
  const authorOf = (r) =>
    (r.authorAttribution && r.authorAttribution.displayName) || "";
  const bodyOf = (r) =>
    ((r.text && r.text.text) || (r.originalText && r.originalText.text) || "")
      .replace(/\s+/g, "");

  /* 主キー: 投稿者名 + 投稿日時(秒) */
  const timeKey = (r) => {
    const author = authorOf(r);
    const time = secondsOf(r.publishTime);
    if (!author && !time) return null;
    return `k1|${author}|${time}`;
  };
  /* 副キー: 投稿者名 + 本文の先頭60文字 */
  const textKey = (r) => {
    const author = authorOf(r);
    const body = bodyOf(r);
    if (!author && !body) return null;
    return `k2|${author}|${body.slice(0, 60)}`;
  };

  const out = [];
  const index = new Map();
  const register = (item) => {
    for (const k of [timeKey(item), textKey(item)]) {
      if (k) index.set(k, item);
    }
  };

  for (const r of relevant || []) {
    const item = { ...r, _source: "relevant" };
    register(item);
    out.push(item);
  }
  for (const r of newest || []) {
    const hit = index.get(timeKey(r)) || index.get(textKey(r));
    if (hit) {
      /* 両方に出てきたクチコミ。新着順にも含まれる = 直近の投稿である */
      hit._source = "both";
      continue;
    }
    const item = { ...r, _source: "newest" };
    register(item);
    out.push(item);
  }
  return out;
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

  /* 新着順クチコミを追加取得してマージする。取得できなければ従来どおり
   * 関連度順のみで返す(このとき hasNewest=false をフロントへ伝える)。 */
  const legacy = await fetchNewestReviews(placeId, env);
  const newest = legacy && legacy.reviews;
  const relevant = data.reviews || [];
  const merged = newest
    ? mergeReviews(relevant, newest)
    : relevant.map((r) => ({ ...r, _source: "relevant" }));

  return json(
    {
      ...data,
      reviews: merged,
      reviewSources: {
        hasNewest: !!newest,
        relevantCount: relevant.length,
        newestCount: newest ? newest.length : 0,
        mergedCount: merged.length,
        /* 取得できなかった理由。運用時の切り分け用 */
        newestError: newest ? null : (legacy && legacy.reason) || "unknown",
        newestErrorDetail: (legacy && legacy.detail) || undefined,
      },
    },
    200,
    origin
  );
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
