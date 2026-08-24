/* =========================================================================
 * サクラメーター 分析エンジン (analyzer.js)
 *
 * 公開情報(評価・件数・クチコミ本文)から「サクラ的パターン一致度」を
 * 参考値として推定する。断定を目的としない。
 *
 * 設計方針:
 *  - 5つの独立シグナルを 0-100 で採点し、重み付き平均で合成する
 *  - データ不足のシグナルは除外し、残りの重みを再配分する
 *  - 低評価が混在するサンプルは緩和係数をかける(自然なクチコミ分布の兆候)
 *  - すべてのシグナルは根拠(evidence)と代替説明(altExplanation)を持ち、
 *    UI側でそのまま利用者に開示される
 * ========================================================================= */

const Analyzer = (() => {
  "use strict";

  /* ---- 定数: シグナル重み (合計 1.0) ----
   * 文章パターン(S4)を最重視するのは、業界で知られるサクラ投稿の特徴が
   * 最も強く現れるのが本文だという運用知見に基づく。 */
  const WEIGHTS = {
    ratingAnomaly: 0.15,
    peerDeviation: 0.15,
    burst: 0.15,
    textPattern: 0.40,
    ratingTextGap: 0.15,
  };

  /* Bayesian 縮約の事前分布: 日本の飲食店の Google 評価は概ね 3.2〜3.9 に
   * 集まるため、事前平均 3.5 / 事前重み 30 件で少件数の高評価を割り引く */
  const PRIOR_MEAN = 3.5;
  const PRIOR_WEIGHT = 30;

  /* 定型的な称賛フレーズ(具体性を伴わない場合にサクラ的とされる表現) */
  const GENERIC_PHRASES = [
    "美味しかった", "おいしかった", "美味しいです", "おいしいです",
    "最高", "また行きたい", "また来たい", "また行きます", "また来ます",
    "おすすめ", "オススメ", "お勧め",
    "雰囲気が良", "雰囲気も良", "接客が丁寧", "接客も丁寧", "店員さんが親切",
    "コスパ", "間違いない", "絶対", "感動", "大満足", "満足です",
    "素晴らしい", "文句なし", "ハズレなし", "リピ確定", "神",
  ];

  /* 具体性マーカー: 実体験に根ざしたクチコミに現れやすい要素 */
  const SPECIFIC_PATTERNS = [
    /[0-9０-９,，]+円/,                  // 価格への言及
    /[0-9０-９]+分/,                     // 待ち時間・提供時間
    /注文|頼ん|オーダー/,                 // 注文行動
    /[ァ-ヴー]{4,}/,                     // 長いカタカナ語(料理名など)
    /再訪|リピート|[0-9０-９]+回目|以前|前回|久しぶり/, // 来店履歴
    /ランチ|定食|コース|単品|大盛|替え玉|飲み放題|食べ放題/,
    /隣|カウンター|座敷|個室|テーブル席/,  // 店内描写
    /残念|惜しい|ただ|欠点|マイナス/,      // 率直な留保(サクラは書かない傾向)
  ];

  const DAY_MS = 24 * 60 * 60 * 1000;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* 区分線形マッピング: [[x0,y0],[x1,y1],...] を通る折れ線で x→y */
  function piecewise(x, points) {
    if (x <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      if (x <= points[i][0]) {
        const [x0, y0] = points[i - 1];
        const [x1, y1] = points[i];
        return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    return points[points.length - 1][1];
  }

  function fmtDate(d) {
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  /* ---- S1: 評価水準の統計的偏り -------------------------------------- */
  function scoreRatingAnomaly(rating, count) {
    if (rating == null || !count) {
      return insufficient("rating_anomaly", "評価または件数が取得できませんでした。");
    }
    const adj = (PRIOR_WEIGHT * PRIOR_MEAN + rating * count) / (PRIOR_WEIGHT + count);
    /* 「一般的な水準(3.2〜3.9)」を上振れと呼ばないよう、加点の起点を
     * その上限である 3.9 に合わせている */
    const score = clamp(piecewise(adj, [
      [3.9, 0], [4.15, 20], [4.35, 45], [4.6, 75], [4.85, 100],
    ]), 0, 100);
    return {
      id: "rating_anomaly",
      score: Math.round(score),
      included: true,
      evidence: `評価 ${rating.toFixed(1)}(${count}件)。件数を考慮した補正後評価は ${adj.toFixed(2)} です。国内飲食店の一般的な水準の上限(3.9)からの上振れ幅を採点しています。`,
    };
  }

  /* ---- S2: 周辺同条件店舗との乖離 ------------------------------------ */
  function scorePeerDeviation(rating, peers) {
    const usable = (peers || []).filter(
      (p) => p && p.rating != null && (p.userRatingCount || 0) >= 5
    );
    if (rating == null || usable.length < 5) {
      return insufficient(
        "peer_deviation",
        `比較対象となる周辺店舗のデータが不足しています(${usable.length}件、5件以上必要)。`
      );
    }
    const mean = usable.reduce((s, p) => s + p.rating, 0) / usable.length;
    const variance =
      usable.reduce((s, p) => s + (p.rating - mean) ** 2, 0) / usable.length;
    const std = Math.max(Math.sqrt(variance), 0.15);
    const z = (rating - mean) / std;
    const score = clamp(piecewise(z, [
      [0.5, 0], [1.5, 35], [2.5, 75], [3.5, 100],
    ]), 0, 100);
    return {
      id: "peer_deviation",
      score: Math.round(score),
      included: true,
      evidence: `同じ検索結果内の周辺${usable.length}店舗の平均評価は ${mean.toFixed(2)}(標準偏差 ${std.toFixed(2)})。この店舗の評価 ${rating.toFixed(1)} は平均から ${z.toFixed(1)}σ の位置にあります。`,
    };
  }

  /* ---- S3: 投稿時期の集中(バースト) ----------------------------------
   * 注意: Google Places API (New) が返すクチコミは投稿日時の新しい順では
   * なく「関連度順(most relevant)」で最大5件。取得後に日付でソートして
   * いるが、これは店舗の全期間から関連度で選ばれた最大5件の投稿日時の
   * ばらつきを見ているに過ぎず、真の「直近投稿の集中」を厳密には測れて
   * いない(計測方法モーダルで開示)。 */
  function scoreBurst(reviews, count) {
    const dated = (reviews || [])
      .map((r) => (r.publishTime ? new Date(r.publishTime) : null))
      .filter((d) => d && !isNaN(d.getTime()))
      .sort((a, b) => b - a); // 新しい順
    if (dated.length < 4) {
      return insufficient(
        "burst",
        `投稿日時つきのクチコミが${dated.length}件しかなく、時期の分析には4件以上必要です。`
      );
    }
    const recent = dated.slice(0, 5);
    const newest = recent[0];
    const oldest = recent[recent.length - 1];
    const spanDays = Math.max(0, Math.round((newest - oldest) / DAY_MS));
    let score;
    if (spanDays <= 10 && (count || 0) >= 30) score = 95;
    else if (spanDays <= 30) score = 70;
    else if (spanDays <= 90) score = 40;
    else if (spanDays <= 180) score = 20;
    else score = 5;
    return {
      id: "burst",
      score,
      included: true,
      evidence: `取得できたクチコミ${recent.length}件は ${fmtDate(oldest)} 〜 ${fmtDate(newest)} の${spanDays}日間に投稿されています(Google APIの仕様上、関連度順で選ばれた最大5件)。この期間が短いほどスコアが高くなります。`,
    };
  }

  /* ---- S4: クチコミ本文の定型度 -------------------------------------- */
  function reviewGenericness(text) {
    const t = (text || "").trim();
    if (!t) return { g: 0.75, hits: 0, specifics: 0, len: 0 };
    let g = 0;
    const len = t.length;
    if (len < 15) g += 0.5;
    else if (len < 40) g += 0.25;

    const hits = GENERIC_PHRASES.filter((p) => t.includes(p)).length;
    if (hits >= 2) g += 0.3;
    else if (hits === 1) g += 0.15;

    const specifics = SPECIFIC_PATTERNS.filter((re) => re.test(t)).length;
    if (specifics === 0) g += 0.25;
    else if (specifics >= 2) g -= 0.3;

    const bangs = (t.match(/[!！]/g) || []).length;
    if (bangs / len > 0.08) g += 0.1;

    return { g: clamp(g, 0, 1), hits, specifics, len };
  }

  /* 文字バイグラムの Jaccard 類似度(コピペ・使い回し文の検出) */
  function bigramSimilarity(a, b) {
    const grams = (s) => {
      const set = new Set();
      const t = (s || "").replace(/\s/g, "");
      for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
      return set;
    };
    const A = grams(a);
    const B = grams(b);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    return inter / (A.size + B.size - inter);
  }

  function scoreTextPattern(reviews) {
    const positive = (reviews || []).filter((r) => (r.rating || 0) >= 4);
    if (positive.length < 2) {
      return insufficient(
        "text_pattern",
        `本文を分析できる高評価クチコミが${positive.length}件しかありません(2件以上必要)。`
      );
    }
    const stats = positive.map((r) => reviewGenericness(r.text));
    const meanG = stats.reduce((s, x) => s + x.g, 0) / stats.length;

    let maxSim = 0;
    const texts = positive.map((r) => r.text || "").filter((t) => t.length >= 10);
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        maxSim = Math.max(maxSim, bigramSimilarity(texts[i], texts[j]));
      }
    }
    const dupBonus = maxSim > 0.35 ? clamp(((maxSim - 0.35) / 0.35) * 30, 0, 30) : 0;
    const score = clamp(Math.round(meanG * 70 + dupBonus), 0, 100);

    const genericCount = stats.filter((x) => x.g >= 0.5).length;
    const noSpecific = stats.filter((x) => x.specifics === 0).length;
    let ev = `高評価クチコミ${positive.length}件のうち、定型的と判定した文が${genericCount}件、価格・料理名・注文内容など具体的な記述を含まない文が${noSpecific}件です。`;
    if (dupBonus > 0) {
      ev += ` また、文面が強く類似するクチコミの組があります(類似度 ${(maxSim * 100).toFixed(0)}%)。`;
    }
    return { id: "text_pattern", score, included: true, evidence: ev };
  }

  /* ---- S5: 星の数と本文の乖離 ---------------------------------------- */
  function scoreRatingTextGap(reviews) {
    const five = (reviews || []).filter((r) => (r.rating || 0) >= 5);
    if (five.length === 0) {
      return insufficient("rating_text_gap", "分析対象に★5のクチコミがありません。");
    }
    const thin = five.filter((r) => ((r.text || "").trim().length) < 15).length;
    const score = Math.round((thin / five.length) * 100);
    return {
      id: "rating_text_gap",
      score,
      included: true,
      evidence: `★5のクチコミ${five.length}件のうち、本文が15文字未満(または空)のものが${thin}件です。実体験を伴わない投稿は本文が極端に短くなる傾向があります。`,
    };
  }

  function insufficient(id, reason) {
    return { id, score: null, included: false, evidence: reason };
  }

  /* ---- シグナル定義(表示用メタデータ) -------------------------------- */
  const SIGNAL_META = {
    rating_anomaly: {
      label: "評価水準の偏り",
      weight: WEIGHTS.ratingAnomaly,
      description: "件数を考慮して補正した平均評価が、国内飲食店の一般的な水準からどれだけ上振れしているか。",
      altExplanation: "本当に優れた人気店でも高くなります。この指標だけで判断はできません。",
    },
    peer_deviation: {
      label: "周辺相場との乖離",
      weight: WEIGHTS.peerDeviation,
      description: "同じ検索結果に表示された周辺店舗の評価分布と比べた突出度(zスコア)。",
      altExplanation: "エリアで唯一の名店や、競合の少ない業態でも高くなり得ます。",
    },
    burst: {
      label: "投稿時期の集中",
      weight: WEIGHTS.burst,
      description: "取得できたクチコミ(Google APIの仕様上、関連度順で選ばれた最大5件)の投稿日が短期間に集中していないか。サクラ発注は短期集中で反映される傾向があります。",
      altExplanation: "テレビ・SNSでの話題化、開店直後、キャンペーン実施でも同じパターンが生じます。また関連度順での抽出のため、真の直近投稿の集中度とは異なる場合があります。",
    },
    text_pattern: {
      label: "本文の定型度",
      weight: WEIGHTS.textPattern,
      description: "高評価クチコミの本文が、短文・定型フレーズ中心で具体性(価格・料理名・注文内容など)を欠いていないか。文面の使い回しも検出します。",
      altExplanation: "レビューを書き慣れていない利用者が多い店でも、短文・定型文は自然に増えます。",
    },
    rating_text_gap: {
      label: "★5と本文の乖離",
      weight: WEIGHTS.ratingTextGap,
      description: "★5評価のクチコミのうち、本文が15文字未満(空を含む)のものの割合。",
      altExplanation: "常連客が気軽に星だけ付ける文化の店でも高くなります。",
    },
  };

  const BANDS = [
    { max: 24, key: "low",      label: "低い",     summary: "現時点の公開データからは、特段の不自然さは見られません。" },
    { max: 49, key: "mild",     label: "やや注意", summary: "一部にサクラ的パターンと重なる特徴が見られます。参考程度にご覧ください。" },
    { max: 74, key: "caution",  label: "注意",     summary: "複数のサクラ的パターンと重なる特徴が見られます。ただし話題化や偶然の一致でも同様のパターンは生じるため、断定はできません。クチコミ本文をご自身でも確認することをおすすめします。" },
    { max: 100, key: "strong",  label: "強い注意", summary: "サクラ的パターンと重なる特徴が強く見られます。ただし話題化などでも同様のパターンは生じるため、断定はできません。クチコミ本文をご自身でも確認することをおすすめします。" },
  ];

  /* ---- メイン: analyze ------------------------------------------------ */
  function analyze(place, peers) {
    const reviews = place.reviews || [];
    const raw = [
      scoreRatingAnomaly(place.rating, place.userRatingCount),
      scorePeerDeviation(place.rating, peers),
      scoreBurst(reviews, place.userRatingCount),
      scoreTextPattern(reviews),
      scoreRatingTextGap(reviews),
    ];

    const signals = raw.map((s) => ({ ...SIGNAL_META[s.id], ...s }));
    const included = signals.filter((s) => s.included);
    const totalWeight = included.reduce((sum, s) => sum + s.weight, 0);
    /* 実効重み: 除外シグナルの重み再配分後、実際にスコアへ効いた割合。
     * UI側は静的な既定重みではなく、こちらを表示に使う。 */
    signals.forEach((s) => {
      s.effectiveWeight = s.included && totalWeight > 0 ? s.weight / totalWeight : 0;
    });

    let score = 0;
    let relief = null;
    if (totalWeight > 0) {
      score = included.reduce((sum, s) => sum + s.score * (s.weight / totalWeight), 0);
      /* 緩和要因: 分析サンプルに★3以下が混在 → 自然な分布の兆候 */
      const hasCritical = reviews.some((r) => (r.rating || 0) <= 3);
      if (hasCritical && score > 0) {
        relief = {
          factor: 0.85,
          note: "分析対象のクチコミに★3以下の率直な評価が含まれるため、スコアを15%緩和しました(自然なクチコミ分布の兆候)。",
        };
        score *= 0.85;
      }
      score = clamp(Math.round(score), 0, 100);
    }

    const band = totalWeight > 0 ? BANDS.find((b) => score <= b.max) : null;
    const confidence = assessConfidence(place, peers, reviews, included.length);

    return {
      score: totalWeight > 0 ? score : null,
      band,
      confidence,
      relief,
      signals,
      sampleSize: reviews.length,
      analyzable: totalWeight > 0,
    };
  }

  /* ---- 信頼度: 「分析に使えたデータ量」の指標 ------------------------- */
  function assessConfidence(place, peers, reviews, includedCount) {
    const n = reviews.length;
    const count = place.userRatingCount || 0;
    /* scorePeerDeviation の usable 条件と揃える(そうしないと、この
     * シグナルが対象外なのに信頼度だけ「高」と出る食い違いが起こる) */
    const peerCount = (peers || []).filter(
      (p) => p && p.rating != null && (p.userRatingCount || 0) >= 5
    ).length;
    const reasons = [];

    let level, label;
    if (n < 3 || count < 10 || includedCount < 3) {
      level = "low";
      label = "低";
      if (n < 3) reasons.push(`分析できたクチコミが${n}件と少ない`);
      if (count < 10) reasons.push(`総クチコミ数が${count}件と少ない`);
      if (includedCount < 3) reasons.push("有効なシグナルが3つ未満");
    } else if (n >= 8 && peerCount >= 5 && count >= 50) {
      level = "high";
      label = "高";
      reasons.push(`クチコミ${n}件・周辺比較${peerCount}店舗・総数${count}件を分析`);
    } else {
      level = "mid";
      label = "中";
      reasons.push(`クチコミ${n}件を分析(Google APIの仕様上、取得できる本文は最新最大5件です)`);
    }
    return { level, label, reasons };
  }

  return { analyze, WEIGHTS, SIGNAL_META, BANDS,
           /* テスト用に内部関数も公開 */
           _internal: { reviewGenericness, bigramSimilarity, piecewise } };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Analyzer;
