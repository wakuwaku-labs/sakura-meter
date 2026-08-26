/* =========================================================================
 * サクラメーター 分析エンジン (analyzer.js)
 *
 * 公開情報(評価・件数・クチコミ本文・投稿者名・評価分布)から
 * 「サクラ的パターン一致度」を参考値として推定する。断定を目的としない。
 *
 * 設計方針:
 *  - 実務・学術で知られるサクラ判定の「4軸」に沿ってシグナルを配置する
 *      A. 文体・表現   B. 投稿タイミング   C. 投稿者アカウント   D. 評価分布
 *  - 8つの独立シグナルを 0-100 で採点し、重み付き平均で合成する
 *  - データ不足のシグナルは除外し、残りの重みを再配分する
 *  - 「1つの兆候だけで決めつけない」原則を係数として実装する(複数一致係数)
 *  - すべてのシグナルは根拠(evidence)と代替説明(altExplanation)を持ち、
 *    UI側でそのまま利用者に開示される
 *
 * 主要な参考:
 *  - Luca & Zervas (2016) "Fake It Till You Make It: Reputation,
 *    Competition, and Yelp Review Fraud", Management Science 62(12).
 *    → 偽の疑いでフィルタされたレビューは★1・★5に偏る(極端化)。
 *      評価が弱い店ほど自作自演の高評価を投入しやすい。
 *  - 坂口洋英(2022)「レビューの不正操作に関するサーベイ」(経済産業省)
 *    → 日本のAmazonで削除レビューの★5比率は74%(非削除は55%)。
 * ========================================================================= */

const Analyzer = (() => {
  "use strict";

  /* ---- 判定の4軸 ---- */
  const AXES = {
    text: "A. 文体・表現",
    timing: "B. 投稿タイミング",
    account: "C. 投稿者アカウント",
    level: "D. 評価水準",
    negative: "E. 低評価クチコミの質",
  };

  /* ---- 定数: シグナル重み (合計 1.0) ----
   * 文章パターンを最重視するのは、サクラ投稿の特徴が最も強く現れるのが
   * 本文だという運用知見に基づく。
   * 投稿者アカウント軸は「最も有効」とされるが、Google公式APIが返すのは
   * 投稿者の表示名のみで、レビュー総数・プロフィール充実度・他店への
   * 評価履歴といった決定的な情報が取得できない。そのため実務上の重要度
   * ほどの重みは置けず、低めの 8% に留めている(限界として開示)。 */
  const WEIGHTS = {
    textPattern: 0.31,        // A
    styleUniformity: 0.08,    // A
    ratingTextGap: 0.10,      // A
    burst: 0.16,              // B
    authorPattern: 0.08,      // C
    ratingAnomaly: 0.09,      // D
    peerDeviation: 0.07,      // D
    negativeAttack: 0.11,     // E
  };

  /* Bayesian 縮約の事前分布: 日本の飲食店の Google 評価は概ね 3.2〜3.9 に
   * 集まるため、事前平均 3.5 / 事前重み 30 件で少件数の高評価を割り引く */
  const PRIOR_MEAN = 3.5;
  const PRIOR_WEIGHT = 30;

  /* 定型的な称賛フレーズ(具体性を伴わない場合にサクラ的とされる表現) */
  const GENERIC_PHRASES = [
    "美味しかった", "おいしかった", "美味しいです", "おいしいです", "美味しい",
    "また行きたい", "また来たい", "また行きます", "また来ます", "また利用",
    "おすすめ", "オススメ", "お勧め", "また訪れ",
    "雰囲気が良", "雰囲気も良", "接客が丁寧", "接客も丁寧", "店員さんが親切",
    "スタッフの方も", "居心地", "コスパ", "満足です", "大変満足",
    "ありがとうございました", "また利用させて",
  ];

  /* 過度な絶賛表現: 具体性を伴わずに現れると強いサクラ的兆候 */
  const SUPERLATIVE_PHRASES = [
    "最高", "人生で一番", "人生最高", "文句なし", "非の打ちどころ",
    "間違いない", "絶品", "感動", "大満足", "ハズレなし", "リピ確定",
    "言うことなし", "完璧", "パーフェクト", "最強", "神", "至福",
    "生涯", "涙が出",
  ];

  /* 酷評・攻撃表現。低評価クチコミが「具体的な不満の説明」ではなく
   * 「罵倒だけ」になっていないかを見るための語彙。
   * 注意: 本物の怒った利用者もこれらの語を使う。単独では証拠にならず、
   *      「酷評 × 具体性の欠如」の組み合わせで初めて意味を持つ。 */
  const ATTACK_PHRASES = [
    "最悪", "最低", "二度と", "ありえない", "あり得ない", "ふざけ",
    "詐欺", "ぼったくり", "ぼられ", "金返せ", "金返し", "返金しろ",
    "潰れ", "つぶれろ", "行く価値", "行かない方", "来ない方",
    "おすすめしません", "お勧めしません", "勧めません",
    "不衛生", "汚い", "きたない", "不潔", "虫が",
    "態度が悪", "無愛想", "無礼", "失礼", "偉そう", "上から目線",
    "腹が立", "ムカつ", "不快", "気分が悪",
    "騙され", "だまされ", "嘘", "地雷", "残飯", "食えたもの",
    "まずい", "不味い", "訴え",
  ];

  /* 上のうち、本物の利用者はまず書かない強い全否定・人格攻撃 */
  const SEVERE_ATTACK_PHRASES = [
    "潰れ", "つぶれろ", "詐欺", "騙され", "だまされ", "金返せ",
    "残飯", "地雷", "ふざけ", "訴え",
  ];

  /* 留保・率直な指摘: サクラ投稿には現れにくい(本物らしさの証拠) */
  const RESERVATION_PATTERNS = [
    /残念|惜しい|欠点|マイナス|difficult/,
    /ただ、|ただし|とはいえ|しかし|但し/,
    /かも(しれ|しれま)|かな(と思|？)|好みが分かれ|人を選/,
    /少し(高|狭|遠|辛|薄|濃)|やや(高|狭|遠|辛|薄|濃)|物足りな/,
    /待ち|混雑|並[びぶん]|行列/,
  ];

  /* 具体性マーカー: 実体験に根ざしたクチコミに現れやすい要素 */
  const SPECIFIC_PATTERNS = [
    /[0-9０-９,，]+\s*円/,                            // 価格への言及
    /[0-9０-９]+\s*(分|時間)/,                        // 待ち時間・提供時間
    /[0-9０-９]+\s*(人|名|品|本|杯|皿|g|グラム|ｇ)/,   // 数量
    /注文|頼ん|オーダー|券売機|予約|取り置き/,          // 注文行動
    /再訪|リピート|[0-9０-９]+回目|以前|前回|久しぶり|通って/, // 来店履歴
    /ランチ|定食|コース|単品|大盛|替え玉|飲み放題|食べ放題|セット|日替わり/,
    /隣|カウンター|座敷|個室|テーブル席|二階|地下|テラス/, // 店内描写
    /平日|土日|金曜|週末|開店|閉店|ラストオーダー|[0-9０-９]+時/, // 時間帯
    /駐車場|最寄|徒歩[0-9０-９]|駅から/,                // アクセス
  ];

  /* 実体験を示す動詞・語尾 */
  const EXPERIENCE_PATTERNS = [
    /ました|ません|でした|いたしました/,
    /頂[きい]|いただ[きい]|食べ|飲[んみ]|味わ/,
    /行っ|訪れ|伺[いっ]|来店|入店|寄っ/,
    /待[った]|並[んび]|座っ|案内|通され/,
  ];

  /* 「長いカタカナ語＝料理名」判定の誤爆を防ぐ除外語。
   * (旧実装は「オススメ」「リピート」なども具体性としてカウントしていた) */
  const KATAKANA_STOPWORDS = new Set([
    "オススメ", "オスス", "リピート", "リピーター", "サービス", "スタッフ",
    "ボリューム", "メニュー", "ドリンク", "デート", "アクセス", "タイミング",
    "コスパ", "クオリティ", "ロケーション", "アットホーム", "シチュエーション",
    "ファミリー", "テイクアウト", "オーダー", "カップル", "ホスピタリティ",
  ]);

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

  function insufficient(id, reason) {
    return { id, score: null, included: false, evidence: reason, detail: {} };
  }

  /* =====================================================================
   * A. 文体・表現の軸
   * ===================================================================== */

  /* 日本語で書かれたクチコミかどうか。
   *
   * 本ツールの文章解析(定型フレーズ・具体性マーカー・体験動詞・酷評語)は
   * すべて日本語の語彙に依存している。英語などのクチコミにそのまま当てる
   * と、どのパターンにもマッチしないため「具体性ゼロ・体験記述ゼロ」と
   * 判定され、実際には非常に具体的な内容でも定型文扱いになってしまう。
   * 観光地や都心の飲食店では外国語のクチコミが関連度上位を占めることが
   * 珍しくないため、実害が大きい。日本語以外は解析対象から外す。 */
  function isJapanese(text) {
    const t = (text || "").trim();
    if (!t) return false;
    const jp = (t.match(/[ぁ-んァ-ヴ一-龠々ー]/g) || []).length;
    return jp >= 3 && jp / t.length >= 0.15;
  }

  /* 1件のクチコミの「定型度」を 0〜1 で返す */
  function reviewGenericness(text) {
    const t = (text || "").trim();
    if (!t) return { g: 0.8, generic: 0, superlative: 0, specifics: 0, len: 0, reserved: false };

    const len = t.length;
    let g = 0;

    /* 短さ: 実体験の描写は物理的に一定の長さを要する */
    if (len < 15) g += 0.45;
    else if (len < 30) g += 0.28;
    else if (len < 60) g += 0.12;

    const generic = GENERIC_PHRASES.filter((p) => t.includes(p)).length;
    g += Math.min(generic, 3) * 0.09;

    const superlative = SUPERLATIVE_PHRASES.filter((p) => t.includes(p)).length;
    g += Math.min(superlative, 3) * 0.10;

    const specifics = countSpecifics(t);
    if (specifics === 0) g += 0.22;
    else if (specifics === 2) g -= 0.15;
    else if (specifics >= 3) g -= 0.30;

    /* 実体験を示す動詞が皆無 = メニュー説明・宣伝文の可能性 */
    const experience = EXPERIENCE_PATTERNS.filter((re) => re.test(t)).length;
    if (experience === 0) g += 0.10;

    /* 率直な留保はサクラ投稿にはまず現れない(強い本物らしさの証拠) */
    const reserved = RESERVATION_PATTERNS.some((re) => re.test(t));
    if (reserved) g -= 0.14;

    const bangs = (t.match(/[!！]/g) || []).length;
    if (len > 0 && bangs / len > 0.06) g += 0.08;

    return { g: clamp(g, 0, 1), generic, superlative, specifics, len, reserved };
  }

  /* 具体性マーカーの個数。長いカタカナ語(料理名など)も1点として数えるが、
   * 「オススメ」等のありふれた語は除外する */
  function countSpecifics(t) {
    let n = SPECIFIC_PATTERNS.filter((re) => re.test(t)).length;
    const katakana = (t.match(/[ァ-ヴー]{4,}/g) || []).filter(
      (w) => !KATAKANA_STOPWORDS.has(w)
    );
    if (katakana.length > 0) n += 1;
    return n;
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

  /* ---- S1: クチコミ本文の定型度 -------------------------------------- */
  function scoreTextPattern(reviews) {
    const allPositive = (reviews || []).filter((r) => (r.rating || 0) >= 4);
    const positive = allPositive.filter((r) => isJapanese(r.text));
    const foreign = allPositive.length - positive.length;
    if (positive.length < 2) {
      return insufficient(
        "text_pattern",
        `本文を分析できる日本語の高評価クチコミが${positive.length}件しかありません(2件以上必要)。`
          + (foreign > 0
              ? `${foreign}件は日本語以外のため対象外としています(本ツールの文章解析は日本語の語彙に依存しており、外国語のクチコミに当てると、具体的な内容でも定型文と誤判定してしまうためです)。`
              : "")
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
    const superlativeOnly = stats.filter((x) => x.superlative > 0 && x.specifics === 0).length;
    const reservedCount = stats.filter((x) => x.reserved).length;

    let ev = `日本語の高評価クチコミ${positive.length}件のうち、定型的と判定した文が${genericCount}件、価格・料理名・注文内容など具体的な記述を含まない文が${noSpecific}件です。`;
    if (superlativeOnly > 0) {
      ev += ` うち${superlativeOnly}件は「最高」「間違いない」等の絶賛表現を含みながら具体的な記述がありません。`;
    }
    if (reservedCount > 0) {
      ev += ` 一方、率直な留保(待ち時間・好みが分かれる点など)に触れた文が${reservedCount}件あり、これは本物らしさの側の材料として減点しています。`;
    }
    if (dupBonus > 0) {
      ev += ` また、文面が強く類似するクチコミの組があります(類似度 ${(maxSim * 100).toFixed(0)}%)。`;
    }
    if (foreign > 0) {
      ev += ` なお、日本語以外のクチコミ${foreign}件は解析対象から除外しています。`;
    }
    return {
      id: "text_pattern",
      score,
      included: true,
      evidence: ev,
      detail: { genericCount, noSpecific, superlativeOnly, reservedCount, maxSim, n: positive.length },
    };
  }

  /* ---- S2: 文体の均質性 -----------------------------------------------
   * 別人が書いたはずのクチコミが、語彙・文末・文長のいずれでも不自然に
   * 揃っている場合、同一人物・同一業者による量産、または生成AIの使い回しを
   * 疑う。近年は日本語として自然なAI生成レビューが増え、「不自然な日本語」
   * を手掛かりにできなくなったため、代わりに「揃いすぎ」を見る。
   *
   * 重要な補正(具体性ゲート):
   *   丁寧に書く常連が多い店では、本物のクチコミでも文長・文末は自然に
   *   揃う。揃っていること自体は証拠にならない。そこで、価格・料理名・
   *   注文内容といった具体的記述が豊富なほどスコアを大きく減衰させる。 */
  function scoreStyleUniformity(reviews) {
    const all = (reviews || []).filter(
      (r) => (r.rating || 0) >= 4 && (r.text || "").trim().length >= 10
    );
    /* 機械翻訳された文は除外する。Googleが外国語のクチコミを翻訳して返す
     * 場合、別人が書いた複数のクチコミが同じ翻訳エンジンの文体になり、
     * 「揃っている」と誤判定してしまう。 */
    const usable = all.filter((r) => !r.translated && isJapanese(r.text));
    const excluded = all.length - usable.length;
    if (usable.length < 3) {
      return insufficient(
        "style_uniformity",
        `文体を比較できる高評価クチコミが${usable.length}件しかありません(3件以上必要)。`
          + (excluded > 0 ? `機械翻訳された文と日本語以外の文、あわせて${excluded}件を除外しています(文末表現の型が日本語を前提としているため)。` : "")
      );
    }
    const authors = new Set(usable.map((r) => r.author || ""));
    if (authors.size <= 1) {
      return insufficient(
        "style_uniformity",
        "比較対象のクチコミが同一投稿者のため、文体の揃い方は判断材料になりません。"
      );
    }

    const feats = usable.map((r) => {
      const t = r.text.trim();
      return { text: t, len: t.length, ending: endingForm(t), specifics: countSpecifics(t) };
    });

    /* (1) 語彙の重なり: 全ペアの平均類似度。テンプレート量産で上がる */
    let simSum = 0, pairs = 0;
    for (let i = 0; i < feats.length; i++) {
      for (let j = i + 1; j < feats.length; j++) {
        simSum += bigramSimilarity(feats[i].text, feats[j].text);
        pairs++;
      }
    }
    const meanSim = pairs > 0 ? simSum / pairs : 0;
    const simScore = piecewise(meanSim, [[0.08, 0], [0.15, 30], [0.25, 60], [0.38, 85], [0.55, 100]]);

    /* (2) 文末表現の一致率 */
    const endCounts = {};
    feats.forEach((f) => (endCounts[f.ending] = (endCounts[f.ending] || 0) + 1));
    const topEnd = Math.max(...Object.values(endCounts)) / feats.length;
    const endScore = piecewise(topEnd, [[0.50, 0], [0.70, 30], [0.85, 60], [1.0, 85]]);

    /* (3) 文字数のばらつき(変動係数) */
    const lens = feats.map((f) => f.len);
    const meanLen = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sdLen = Math.sqrt(lens.reduce((s, x) => s + (x - meanLen) ** 2, 0) / lens.length);
    const cv = meanLen > 0 ? sdLen / meanLen : 1;
    const lenScore = piecewise(cv, [[0.10, 100], [0.20, 78], [0.35, 45], [0.55, 15], [0.80, 0]]);

    const raw = 0.45 * simScore + 0.25 * endScore + 0.30 * lenScore;

    /* 具体性ゲート: 実体験の具体的記述が多いほど「揃い」を証拠にしない */
    const meanSpec = feats.reduce((s, f) => s + f.specifics, 0) / feats.length;
    const gate = piecewise(meanSpec, [[0.5, 1.0], [1.5, 0.8], [2.5, 0.5], [3.5, 0.3], [5.0, 0.2]]);

    const score = clamp(Math.round(raw * gate), 0, 100);

    return {
      id: "style_uniformity",
      score,
      included: true,
      evidence: `別々の投稿者による高評価クチコミ${usable.length}件について、語彙の重なり(全ペア平均)は${(meanSim * 100).toFixed(0)}%、文末表現は${Math.round(topEnd * 100)}%が同じ型、文字数のばらつきは${(cv * 100).toFixed(0)}%です。1件あたりの具体的記述は平均${meanSpec.toFixed(1)}個で、これが多いほど「揃っていても自然」と判断してスコアを${Math.round((1 - gate) * 100)}%減衰させています。`
        + (excluded > 0 ? ` なお、機械翻訳された${excluded}件は翻訳エンジンの文体に揃ってしまうため除外しました。` : ""),
      detail: { meanSim, topEnd, cv, meanSpec, gate, n: usable.length, authors: authors.size },
    };
  }

  /* 文末の型を4種に丸める(ですます / でした / 常体 / その他) */
  function endingForm(t) {
    const tail = t.replace(/[。\s!！?？…]+$/, "").slice(-3);
    if (/(です|ます)$/.test(tail)) return "ですます";
    if (/(でした|ました)$/.test(tail)) return "でした";
    if (/(い|た|る|う)$/.test(tail)) return "常体";
    return "その他";
  }

  /* ---- S3: 星の数と本文の乖離 ---------------------------------------- */
  function scoreRatingTextGap(reviews) {
    const five = (reviews || []).filter((r) => (r.rating || 0) >= 5);
    if (five.length < 2) {
      return insufficient(
        "rating_text_gap",
        `分析対象の★5クチコミが${five.length}件しかありません(2件以上必要)。`
      );
    }
    const thin = five.filter((r) => ((r.text || "").trim().length) < 15).length;
    const empty = five.filter((r) => ((r.text || "").trim().length) === 0).length;
    /* 少件数で 0% / 100% に振り切れないよう、事前分布(25%相当・重み1)で縮約 */
    const shrunk = (thin + 0.25) / (five.length + 1);
    const score = clamp(Math.round(shrunk * 100), 0, 100);
    return {
      id: "rating_text_gap",
      score,
      included: true,
      evidence: `★5のクチコミ${five.length}件のうち、本文が15文字未満のものが${thin}件(うち本文なしが${empty}件)です。実体験を伴わない投稿は本文が極端に短くなる傾向があります(少件数の振れを抑える補正を入れています)。`,
      detail: { thin, empty, n: five.length, rate: thin / five.length },
    };
  }

  /* =====================================================================
   * B. 投稿タイミングの軸
   * ===================================================================== */

  /* 新着順(reviews_sort=newest)で取得できたクチコミだけを取り出す。
   * これが取れている店舗では「真の直近投稿」を測れる。取れていない店舗
   * (Legacy未使用・上限超過)では空配列が返り、従来どおり関連度順のみで
   * 分析する。 */
  function newestSubset(reviews) {
    return (reviews || []).filter((r) => r.source === "newest" || r.source === "both");
  }

  /* 直近の投稿状況。newest が取れているときだけ意味を持つ */
  function recentActivity(reviews, now) {
    const recent = newestSubset(reviews)
      .map((r) => ({
        date: r.publishTime ? new Date(r.publishTime) : null,
        rating: r.rating || 0,
      }))
      .filter((x) => x.date && !isNaN(x.date.getTime()))
      .sort((a, b) => b.date - a.date);
    if (recent.length < 2) return null;
    const spanDays = (recent[0].date - recent[recent.length - 1].date) / DAY_MS;
    const daysSinceNewest = (now - recent[0].date) / DAY_MS;
    return {
      n: recent.length,
      spanDays,
      daysSinceNewest,
      allHigh: recent.every((x) => x.rating >= 4),
      newest: recent[0].date,
      oldest: recent[recent.length - 1].date,
    };
  }

  /* 降順に並んだ日付配列から、k件が収まる最短の窓を探す */
  function minWindow(items, k) {
    if (items.length < k) return null;
    let best = Infinity;
    let bestIdx = 0;
    for (let i = 0; i + k - 1 < items.length; i++) {
      const span = (items[i].date - items[i + k - 1].date) / DAY_MS;
      if (span < best) {
        best = span;
        bestIdx = i;
      }
    }
    return { days: best, items: items.slice(bestIdx, bestIdx + k) };
  }

  /* ---- S4: 高評価の投稿時期の集中(バースト) --------------------------
   * 注意: Google Places API (New) が返すクチコミは投稿日時の新しい順では
   * なく「関連度順(most relevant)」で最大5件。取得後に日付でソートして
   * いるが、これは店舗の全期間から関連度で選ばれた最大5件の投稿日時の
   * ばらつきを見ているに過ぎない(計測方法モーダルで開示)。
   *
   * このシグナルは「高評価(★4以上)の集中」だけを見る。低評価が短期に
   * 固まるのは逆方向のパターン(第三者による低評価工作の疑い)であり、
   * E軸「低評価クチコミの質」で別途評価する。両者を1つの指標に混ぜると、
   * 攻撃を受けている店が高評価の水増しをしているように見えてしまう。
   *
   * また、全体幅ではなく「3件が収まる最短の窓」を主指標にしている。
   * 全体幅だけを見ると「3年に散らばる5件のうち3件だけが同じ週に固まって
   * いる」という、業者発注に最も典型的なパターンを取りこぼすため。 */
  function scoreBurst(reviews, count, recent) {
    const dated = (reviews || [])
      .map((r) => ({
        date: r.publishTime ? new Date(r.publishTime) : null,
        rating: r.rating || 0,
      }))
      .filter((x) => x.date && !isNaN(x.date.getTime()) && x.rating >= 4)
      .sort((a, b) => b.date - a.date); // 新しい順

    if (dated.length < 3) {
      return insufficient(
        "burst",
        `投稿日時つきの高評価(★4以上)クチコミが${dated.length}件しかなく、時期の分析には3件以上必要です。`
      );
    }

    const win = minWindow(dated, 3);
    const days = win.days;
    const totalSpanDays = Math.round((dated[0].date - dated[dated.length - 1].date) / DAY_MS);

    let score = piecewise(days, [
      [3, 92], [7, 82], [14, 70], [30, 55], [90, 35], [180, 20], [365, 10], [730, 5],
    ]);

    /* 総クチコミ数が多い店ほど「関連度上位が数日に固まる」ことは起きにくい */
    if ((count || 0) >= 100 && days <= 14) score += 6;

    /* 全期間に散らばる中の一部だけが固まっている場合を明示 */
    const isolatedCluster = totalSpanDays > days * 6 && days <= 30;
    if (isolatedCluster) score += 5;

    /* 新着順が取得できている店舗では、関連度順による偏りのない「真の直近
     * 投稿」を評価できる。直近の投稿が短期間に詰まっていて、しかもすべて
     * 高評価なら、発注パターンに強く一致する。 */
    let trueBurst = false;
    if (recent && recent.n >= 3) {
      if (recent.spanDays <= 14 && recent.allHigh && (count || 0) >= 30) {
        score += 12;
        trueBurst = true;
      } else if (recent.spanDays >= 180) {
        /* 直近の投稿がゆっくりしている = 自然な流入 */
        score -= 8;
      }
    }

    score = clamp(Math.round(score), 0, 100);

    const from = win.items[win.items.length - 1].date;
    const to = win.items[0].date;
    let ev = `取得できた高評価クチコミ${dated.length}件のうち、最も密集する3件は ${fmtDate(from)} 〜 ${fmtDate(to)} の${Math.round(days)}日間に投稿されています(高評価全体の投稿期間は${totalSpanDays}日)。`;
    if (isolatedCluster) {
      ev += " 全体としては長期間に分布する中で、一部だけが固まっている形です。";
    }
    if (recent && recent.n >= 3) {
      ev += ` 新着順でも取得できているため、直近の投稿状況を直接確認できます: 最新${recent.n}件は${Math.round(recent.spanDays)}日間に投稿されており`;
      ev += recent.allHigh ? "、いずれも★4以上です。" : "、評価はばらついています。";
      if (trueBurst) ev += " 関連度順の偏りによらず、直近に高評価だけが詰まっている状態です。";
    } else {
      ev += "(新着順のクチコミが取得できなかったため、対象は関連度順で選ばれた最大5件です)";
    }

    return {
      id: "burst",
      score,
      included: true,
      evidence: ev,
      detail: { days, totalSpanDays, isolatedCluster, n: dated.length },
    };
  }

  /* =====================================================================
   * C. 投稿者アカウントの軸
   * ===================================================================== */

  /* 姓名フルネーム型の表示名かどうか。
   * 業者が日本人の典型的な氏名リストからアカウントを量産する際の特徴と
   * されるが、実名で使っている一般利用者も多いため重みは低く抑える。 */
  function isFullNameStyle(name) {
    const n = (name || "").trim();
    if (!n) return false;
    if (/^[一-龠々]{2,3}[ 　][一-龠々]{1,3}$/.test(n)) return true;   // 山田 太郎
    if (/^[一-龠々]{3,5}$/.test(n)) return true;                       // 山田太郎
    /* 「Anna Lam」のような英字の姓名は判定に使わない。英語圏では表示名を
     * 本名にするのがごく普通で、日本の業者アカウントの特徴という前提が
     * 成り立たない。実データで、外国人客の多い店の投稿者が軒並みこの型に
     * 該当し、誤検知の原因になっていた。 */
    return false;
  }

  const ANONYMOUS_NAMES = /^(Google\s?ユーザー|A Google user|ユーザー|匿名)$/i;

  /* ---- S5: 投稿者名の傾向 -------------------------------------------- */
  function scoreAuthorPattern(reviews) {
    const named = (reviews || [])
      .map((r) => (r.author || "").trim())
      .filter((n) => n && !ANONYMOUS_NAMES.test(n));
    if (named.length < 3) {
      return insufficient(
        "author_pattern",
        `投稿者名が判別できるクチコミが${named.length}件しかありません(3件以上必要)。`
      );
    }
    const fullNames = named.filter(isFullNameStyle).length;
    const rate = fullNames / named.length;

    const counts = {};
    named.forEach((n) => (counts[n] = (counts[n] || 0) + 1));
    const dupNames = Object.keys(counts).filter((n) => counts[n] >= 2);

    let score = piecewise(rate, [[0.34, 0], [0.5, 20], [0.7, 42], [0.85, 58], [1.0, 70]]);
    if (dupNames.length > 0) score += 30;
    score = clamp(Math.round(score), 0, 100);

    let ev = `投稿者名が判別できる${named.length}件のうち、姓名フルネーム型の表示名が${fullNames}件(${Math.round(rate * 100)}%)です。`;
    if (dupNames.length > 0) {
      ev += ` また、同一の表示名が複数回登場しています(${dupNames.length}名)。`;
    }
    ev += " Google公式APIは投稿者の総レビュー数・投稿履歴を提供しないため、この軸で見られるのは表示名のみです。";

    return {
      id: "author_pattern",
      score,
      included: true,
      evidence: ev,
      detail: { fullNames, rate, n: named.length, dup: dupNames.length },
    };
  }

  /* =====================================================================
   * D. 評価水準の軸
   * ===================================================================== */

  /* ---- S7: 評価水準の統計的偏り -------------------------------------- */
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
      detail: { adj, rating, count },
    };
  }

  /* ---- S8: 周辺同条件店舗との乖離 ------------------------------------ */
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
      detail: { z, mean, std, n: usable.length },
    };
  }

  /* =====================================================================
   * E. 低評価クチコミの質の軸
   *
   * 「★1の中でも、文言がかなり酷評になっているものが多数ある」場合を
   * 捉える。これは高評価の水増しとは逆方向の操作(競合など第三者による
   * 低評価工作、いわゆる逆サクラ)の兆候であり、この場合お店は被害を
   * 受けている側になる。方向の読み違いを防ぐため、analyze() は結果に
   * 「パターンの向き」を添えて返す。
   *
   * 判別の要は「酷評であること」ではなく「酷評 × 具体性の欠如」。
   * 本物の不満客は、何を注文し、何が起きて、どう不快だったかを具体的に
   * 書く傾向がある。実際に来店していない投稿は罵倒だけになりやすい。
   * ===================================================================== */

  /* 1件の低評価クチコミの「実体験を伴わない酷評らしさ」を 0〜1 で返す */
  function reviewHostility(text) {
    const t = (text || "").trim();
    const len = t.length;
    if (!len) return { h: 0, mild: 0, severe: 0, specifics: 0, len: 0 };

    const mild = ATTACK_PHRASES.filter((p) => t.includes(p)).length;
    const severe = SEVERE_ATTACK_PHRASES.filter((p) => t.includes(p)).length;

    let sev = Math.min(mild, 4) * 0.15 + Math.min(severe, 2) * 0.20;
    if (len < 25 && mild >= 1) sev += 0.20;  // 短い罵倒だけ
    if (len < 12 && mild >= 1) sev += 0.10;
    sev = clamp(sev, 0, 1);
    if (sev === 0) return { h: 0, mild, severe, specifics: countSpecifics(t), len };

    /* 具体性が高いほど「正当な苦情」とみなして減点する */
    const specifics = countSpecifics(t);
    let credit = specifics >= 3 ? 0.75 : specifics >= 2 ? 0.5 : specifics >= 1 ? 0.25 : 0;
    const experience = EXPERIENCE_PATTERNS.filter((re) => re.test(t)).length;
    if (experience === 0) credit *= 0.5;  // 来店した形跡すらない

    return { h: clamp(sev * (1 - credit), 0, 1), mild, severe, specifics, len };
  }

  /* ---- S9: 低評価クチコミの酷評度 ------------------------------------ */
  function scoreNegativeAttack(reviews) {
    const allLow = (reviews || []).filter((r) => (r.rating || 0) > 0 && (r.rating || 0) <= 2);
    /* 酷評語のリストも日本語依存のため、日本語のクチコミだけを対象にする。
     * ただし本文が空の低評価は「本文なしの★1」として意味があるので残す。 */
    const low = allLow.filter((r) => isJapanese(r.text) || !(r.text || "").trim());
    if (low.length < 2) {
      return insufficient(
        "negative_attack",
        `★1〜2のクチコミが${low.length}件しかありません(2件以上必要)。Google公式APIは関連度順で最大5件しか返さないため、実際には低評価が多くても取得できない場合があります。`
      );
    }
    const stats = low.map((r) => reviewHostility(r.text));
    const meanH = stats.reduce((a, x) => a + x.h, 0) / stats.length;
    const harsh = stats.filter((x) => x.h >= 0.4).length;
    const noSpecific = stats.filter((x) => x.h >= 0.4 && x.specifics === 0).length;

    let score = meanH * 75;
    const parts = [];

    /* 低評価どうしの文面の使い回し */
    const texts = low.map((r) => (r.text || "").trim()).filter((t) => t.length >= 10);
    let maxSim = 0;
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        maxSim = Math.max(maxSim, bigramSimilarity(texts[i], texts[j]));
      }
    }
    if (maxSim > 0.35) {
      score += clamp(((maxSim - 0.35) / 0.35) * 25, 0, 25);
      parts.push(`文面が強く似た低評価の組があります(類似度 ${(maxSim * 100).toFixed(0)}%)`);
    }

    /* 低評価の短期集中 */
    const dated = low
      .map((r) => ({ date: r.publishTime ? new Date(r.publishTime) : null, rating: r.rating }))
      .filter((x) => x.date && !isNaN(x.date.getTime()))
      .sort((a, b) => b.date - a.date);
    let clusterDays = null;
    if (dated.length >= 2) {
      clusterDays = Math.round((dated[0].date - dated[dated.length - 1].date) / DAY_MS);
      if (clusterDays <= 14) {
        score += 15;
        parts.push(`${dated.length}件の低評価が${clusterDays}日以内に集中しています`);
      }
    }

    score = clamp(Math.round(score), 0, 100);

    let ev = `★1〜2のクチコミ${low.length}件のうち、罵倒・全否定が中心と判定した文が${harsh}件`;
    ev += noSpecific > 0
      ? `(うち${noSpecific}件は、注文内容・待ち時間・具体的な出来事などの記述が一切ありません)。`
      : `です。`;
    ev += " 本物の不満客は「何を注文し、何が起きて、どう不快だったか」を具体的に書く傾向があるため、具体性を伴う低評価は減点しています。";
    if (parts.length) ev += " " + parts.join("。") + "。";

    return {
      id: "negative_attack",
      score,
      included: true,
      evidence: ev,
      detail: { meanH, harsh, noSpecific, n: low.length, maxSim, clusterDays },
    };
  }

  /* ---- シグナル定義(表示用メタデータ) -------------------------------- */
  const SIGNAL_META = {
    text_pattern: {
      label: "本文の定型度",
      axis: AXES.text,
      weight: WEIGHTS.textPattern,
      description: "高評価クチコミの本文が、短文・定型フレーズ・具体性を欠いた絶賛に偏っていないか。文面の使い回し(コピペ)も検出します。逆に、待ち時間や好みが分かれる点といった率直な留保があれば減点します。",
      altExplanation: "レビューを書き慣れていない利用者が多い店でも、短文・定型文は自然に増えます。テイクアウト中心の店など、書くことが少ない業態でも短くなりがちです。",
    },
    style_uniformity: {
      label: "文体の均質性",
      axis: AXES.text,
      weight: WEIGHTS.styleUniformity,
      description: "別々の投稿者による高評価クチコミなのに、使う語彙・文末表現・文字数が不自然に揃っていないか。生成AIや同一業者による量産で起こりやすいパターンです。ただし具体的な記述が多いクチコミでは「揃っていて当然」とみなし、大きく減点を弱めます。",
      altExplanation: "同じきっかけ(同じキャンペーン、同じテレビ番組)で来店した人たちの感想は、自然に似ることがあります。件数が少ないほど偶然揃う確率も上がります。",
    },
    rating_text_gap: {
      label: "★5と本文の乖離",
      axis: AXES.text,
      weight: WEIGHTS.ratingTextGap,
      description: "★5評価のクチコミのうち、本文が15文字未満(空を含む)のものの割合。件数が少ない場合は極端な値に振れないよう補正しています。",
      altExplanation: "常連客が気軽に星だけ付ける文化の店でも高くなります。スマートフォンから星だけ付ける操作は非常に手軽です。",
    },
    burst: {
      label: "高評価の投稿時期の集中",
      axis: AXES.timing,
      weight: WEIGHTS.burst,
      description: "取得できた高評価(★4以上)クチコミのうち「最も密集する3件」が何日間に収まっているか。サクラ発注はバイトを一定期間で募集するため、短期集中で反映される傾向があります。低評価の集中は逆方向のパターンのため、E軸で別に評価します。",
      altExplanation: "テレビ・SNSでの話題化、開店直後、キャンペーン実施でも同じパターンが生じます。またGoogle公式APIは関連度順で最大5件しか返さないため、店舗の真の投稿状況を厳密に反映しているわけではありません。",
    },
    author_pattern: {
      label: "投稿者名の傾向",
      axis: AXES.account,
      weight: WEIGHTS.authorPattern,
      description: "姓名フルネーム型の表示名の比率と、同一表示名の重複。業者が典型的な氏名リストからアカウントを量産する際の特徴とされます。",
      altExplanation: "実名で普通に使っている利用者も多く、単独では非常に弱い手掛かりです。本来この軸(投稿者のレビュー総数・プロフィール・他店への評価履歴)は最も有効とされますが、Google公式APIは表示名しか提供しないため、重みを低く設定しています。",
    },
    rating_anomaly: {
      label: "評価水準の偏り",
      axis: AXES.level,
      weight: WEIGHTS.ratingAnomaly,
      description: "件数を考慮して補正した平均評価が、国内飲食店の一般的な水準からどれだけ上振れしているか。",
      altExplanation: "本当に優れた人気店でも高くなります。この指標だけで判断はできません。",
    },
    negative_attack: {
      label: "低評価の酷評度",
      axis: AXES.negative,
      weight: WEIGHTS.negativeAttack,
      description: "★1〜2のクチコミが、具体的な不満の説明ではなく罵倒・全否定だけになっていないか。低評価どうしの文面の類似や、短期間への集中も見ます。実際に来店していない投稿は、何を注文したか・何が起きたかを書けないため罵倒だけになりやすいという性質を使っています。",
      altExplanation: "本当にひどい体験をした利用者も、強い言葉で短く書くことがあります。特に衛生面や接客のトラブルは、詳細を書かずに一言で済ませる人が少なくありません。また、このシグナルが高い場合、疑われるのは店舗ではなく第三者(競合など)による低評価工作である可能性があります。",
    },
    peer_deviation: {
      label: "周辺相場との乖離",
      axis: AXES.level,
      weight: WEIGHTS.peerDeviation,
      description: "同じ検索結果に表示された周辺店舗の評価分布と比べた突出度(zスコア)。",
      altExplanation: "エリアで唯一の名店や、競合の少ない業態でも高くなり得ます。",
    },
  };

  /* 表示順(4軸の順に並べる) */
  const SIGNAL_ORDER = [
    "text_pattern", "style_uniformity", "rating_text_gap",
    "burst", "author_pattern",
    "rating_anomaly", "peer_deviation", "negative_attack",
  ];

  /* 高評価側(店舗による水増しを疑うシグナル)。方向の判定に使う */
  const POSITIVE_SIDE_IDS = [
    "text_pattern", "style_uniformity", "rating_text_gap",
    "burst", "author_pattern", "rating_anomaly", "peer_deviation",
  ];

  const BANDS = [
    { max: 24, key: "low",      label: "低い",     summary: "現時点の公開データからは、特段の不自然さは見られません。" },
    { max: 49, key: "mild",     label: "やや注意", summary: "一部にサクラ的パターンと重なる特徴が見られます。参考程度にご覧ください。" },
    { max: 74, key: "caution",  label: "注意",     summary: "複数のサクラ的パターンと重なる特徴が見られます。ただし話題化や偶然の一致でも同様のパターンは生じるため、断定はできません。クチコミ本文をご自身でも確認することをおすすめします。" },
    { max: 100, key: "strong",  label: "強い注意", summary: "サクラ的パターンと重なる特徴が強く見られます。ただし話題化などでも同様のパターンは生じるため、断定はできません。クチコミ本文をご自身でも確認することをおすすめします。" },
  ];

  /* =====================================================================
   * チェックリスト(人が目視で使える12項目に翻訳して開示する)
   * 「3項目以上に該当したら疑いが高い」という実務上の目安に対応する。
   * ===================================================================== */
  function buildChecklist(byId, reviews, recent) {
    const item = (axis, label, state, detail) => ({ axis, label, state, detail });
    const s = (id) => byId[id] || {};
    const d = (id) => (byId[id] && byId[id].detail) || {};
    const list = [];

    /* A. 文体 */
    const tp = s("text_pattern"), tpd = d("text_pattern");
    list.push(item(AXES.text, "具体性を欠く絶賛が高評価クチコミの半数以上",
      tp.included ? (tpd.genericCount / tpd.n >= 0.5 ? "hit" : "clear") : "unknown",
      tp.included ? `定型的と判定: ${tpd.genericCount}/${tpd.n}件` : "本文が2件未満で判定不可"));
    list.push(item(AXES.text, "文面が酷似するクチコミの組がある",
      tp.included ? (tpd.maxSim > 0.35 ? "hit" : "clear") : "unknown",
      tp.included ? `最大類似度 ${(tpd.maxSim * 100).toFixed(0)}%` : "判定不可"));
    const su = s("style_uniformity"), sud = d("style_uniformity");
    list.push(item(AXES.text, "別人の投稿なのに文体・文長が揃いすぎている",
      su.included ? (su.score >= 60 ? "hit" : "clear") : "unknown",
      su.included ? `文字数ばらつき ${(sud.cv * 100).toFixed(0)}% / 文末の一致 ${Math.round(sud.topEnd * 100)}%` : "3件未満で判定不可"));
    const rtg = s("rating_text_gap"), rtgd = d("rating_text_gap");
    list.push(item(AXES.text, "★5なのに本文がほぼ書かれていない投稿が目立つ",
      rtg.included ? (rtgd.rate >= 0.4 ? "hit" : "clear") : "unknown",
      rtg.included ? `★5のうち15文字未満: ${rtgd.thin}/${rtgd.n}件` : "★5が2件未満で判定不可"));

    /* B. タイミング */
    const b = s("burst"), bd = d("burst");
    list.push(item(AXES.timing, "高評価の投稿が短期間(30日以内)に集中している",
      b.included ? (bd.days <= 30 ? "hit" : "clear") : "unknown",
      b.included ? `最密の3件が${Math.round(bd.days)}日間に集中` : "日付付きの高評価が3件未満で判定不可"));
    /* 「短期集中の後、ぱたりと投稿が止まる」— 発注が終わった形。
     * 新着順が取得できて初めて測れる。単に客足が静かなだけの店を巻き込ま
     * ないよう、集中が見えている場合に限って該当とする。 */
    list.push(item(AXES.timing, "高評価の集中のあと、新規投稿が途絶えている",
      recent ? ((b.included && b.score >= 60 && recent.daysSinceNewest >= 120) ? "hit" : "clear") : "unknown",
      recent
        ? `直近の投稿は${Math.round(recent.daysSinceNewest)}日前`
        : "新着順のクチコミが取得できず判定不可"));
    list.push(item(AXES.timing, "その集中が全体の投稿期間から浮いている",
      b.included ? (bd.isolatedCluster ? "hit" : "clear") : "unknown",
      b.included ? (bd.isolatedCluster ? `全体${bd.totalSpanDays}日の分布の中で${Math.round(bd.days)}日に集中` : "全体の分布と大きな差はない") : "判定不可"));

    /* C. アカウント */
    const ap = s("author_pattern"), apd = d("author_pattern");
    list.push(item(AXES.account, "姓名フルネーム型の投稿者名が7割以上",
      ap.included ? (apd.rate >= 0.7 ? "hit" : "clear") : "unknown",
      ap.included ? `${apd.fullNames}/${apd.n}件` : "投稿者名が3件未満で判定不可"));
    list.push(item(AXES.account, "同一の投稿者名が重複している",
      ap.included ? (apd.dup > 0 ? "hit" : "clear") : "unknown",
      ap.included ? (apd.dup > 0 ? `${apd.dup}名が重複` : "重複なし") : "判定不可"));
    list.push(item(AXES.account, "投稿者のレビュー総数・投稿履歴の確認",
      "unknown",
      "Google公式APIが提供しないため、本ツールでは確認できません(Googleマップ上で投稿者名をタップすると手動で確認できます)"));

    /* E. 評価水準 */
    const pd = s("peer_deviation"), pdd = d("peer_deviation");
    list.push(item(AXES.level, "周辺店舗の相場から+2σ以上突出",
      pd.included ? (pdd.z >= 2 ? "hit" : "clear") : "unknown",
      pd.included ? `z = ${pdd.z.toFixed(1)}` : "周辺店舗が5件未満で判定不可"));

    /* F. 低評価の質 */
    const na = s("negative_attack"), nad = d("negative_attack");
    list.push(item(AXES.negative, "具体性を欠く酷評の★1・★2が多い",
      na.included ? (nad.noSpecific >= 2 || (nad.harsh / nad.n) >= 0.5 ? "hit" : "clear") : "unknown",
      na.included
        ? `罵倒中心 ${nad.harsh}/${nad.n}件(うち具体的記述なし ${nad.noSpecific}件)`
        : "★1〜2が2件未満で判定不可"));
    list.push(item(AXES.negative, "低評価が短期間(14日以内)に集中している",
      na.included && nad.clusterDays != null ? (nad.clusterDays <= 14 ? "hit" : "clear") : "unknown",
      na.included && nad.clusterDays != null ? `低評価${nad.n}件が${nad.clusterDays}日間に分布` : "判定不可"));
    list.push(item(AXES.negative, "低評価どうしの文面が似ている",
      na.included ? (nad.maxSim > 0.35 ? "hit" : "clear") : "unknown",
      na.included ? `最大類似度 ${(nad.maxSim * 100).toFixed(0)}%` : "判定不可"));

    const hits = list.filter((x) => x.state === "hit").length;
    const judged = list.filter((x) => x.state !== "unknown").length;
    return { items: list, hits, judged, total: list.length };
  }

  /* ---- 表示サンプルの偏り ---------------------------------------------
   * Google公式APIは星ごとの件数(分布)を返さないため、★1がどれだけ
   * あるかは直接わからない。ただし「返ってきた5件の平均」と「店舗全体の
   * 平均」を比べれば、表示されているクチコミが実態からどちらへずれて
   * いるかは計算できる。スコアには入れず、読み手への注意書きとして返す。
   *
   *   全体平均より高い → 低評価が表示分に含まれていない
   *                      (低評価側の分析ができていない可能性)
   *   全体平均より低い → 低評価が関連度上位を占めている
   *
   * これは操作の証拠ではなく、Googleの関連度選択のクセでも生じる。 */
  function assessSampleBias(place, reviews) {
    const rated = (reviews || []).filter((r) => (r.rating || 0) >= 1);
    if (rated.length < 3 || place.rating == null) return null;
    const sampleMean = rated.reduce((sum, r) => sum + r.rating, 0) / rated.length;
    const gap = sampleMean - place.rating;
    if (Math.abs(gap) < 0.5) return null;

    const lowInSample = rated.filter((r) => r.rating <= 2).length;
    const common = `表示できたクチコミ${rated.length}件の平均は ${sampleMean.toFixed(1)} で、店舗全体の平均 ${place.rating.toFixed(1)} と ${Math.abs(gap).toFixed(1)} 離れています。`;

    if (gap > 0) {
      return {
        key: "hidden-low",
        label: "表示されているクチコミは、店舗全体より高評価に偏っています",
        note: common + `つまり、ここに表示されていないところに低評価がまとまって存在します。`
          + (lowInSample < 2
              ? "低評価の本文が取得できていないため、低評価側の分析(E軸)は行えていません。「判定不可」は「低評価工作がない」という意味ではありません。"
              : "")
          + "Googleマップで低評価のクチコミをご自身でも確認されることをおすすめします。",
      };
    }
    return {
      key: "low-surfaced",
      label: "表示されているクチコミは、店舗全体より低評価に偏っています",
      note: common + "低評価が関連度の上位を占めている状態です。新しい低評価が集中的に投稿された直後にも起こります。",
    };
  }

  /* ---- メイン: analyze ------------------------------------------------ */
  function analyze(place, peers, now) {
    const reviews = place.reviews || [];
    /* now を引数で受け取れるようにしているのはテストのため。省略時は現在時刻 */
    const at = now instanceof Date ? now : new Date();
    const recent = recentActivity(reviews, at);
    const raw = [
      scoreTextPattern(reviews),
      scoreStyleUniformity(reviews),
      scoreRatingTextGap(reviews),
      scoreBurst(reviews, place.userRatingCount, recent),
      scoreAuthorPattern(reviews),
      scoreRatingAnomaly(place.rating, place.userRatingCount),
      scorePeerDeviation(place.rating, peers),
      scoreNegativeAttack(reviews),
    ];

    const byId = {};
    raw.forEach((s) => (byId[s.id] = s));

    const signals = SIGNAL_ORDER.map((id) => ({ ...SIGNAL_META[id], ...byId[id] }));
    const included = signals.filter((s) => s.included);
    const totalWeight = included.reduce((sum, s) => sum + s.weight, 0);
    /* 実効重み: 除外シグナルの重み再配分後、実際にスコアへ効いた割合。
     * UI側は静的な既定重みではなく、こちらを表示に使う。 */
    signals.forEach((s) => {
      s.effectiveWeight = s.included && totalWeight > 0 ? s.weight / totalWeight : 0;
    });

    let score = 0;
    let relief = null;
    let convergence = null;
    if (totalWeight > 0) {
      score = included.reduce((sum, s) => sum + s.score * (s.weight / totalWeight), 0);

      /* --- 複数一致係数 ---
       * 「1つの兆候だけでは決めつけない/複数が重なるほど疑わしい」という
       * 原則を明示的に係数化する。単独突出は誤検知が多いため割り引く。 */
      const strong = included.filter((s) => s.score >= 60).length;
      let factor;
      if (strong >= 3) {
        factor = 1.10;
        convergence = {
          count: strong, factor,
          note: `独立した${strong}つのシグナルが同時に高い値を示しているため、スコアを10%引き上げました(複数の兆候が重なるほど疑わしさが増すという原則によるものです)。`,
        };
      } else if (strong <= 1) {
        factor = 0.85;
        convergence = {
          count: strong, factor,
          note: `高い値を示したシグナルが${strong}つだけで、他の観点とは一致していません。単独の兆候は誤検知になりやすいため、スコアを15%引き下げました。`,
        };
      } else {
        factor = 1.0;
        convergence = { count: strong, factor, note: null };
      }
      score *= factor;

      /* --- 緩和要因 ---
       * 「率直な留保を含む中間評価(★2〜4)」の存在は、自然なクチコミ分布の
       * 兆候。★1は『お椀型(二極化)』というサクラ側のパターンの一部でも
       * あるため、旧実装のように緩和材料として数えない。 */
      /* ★2は「率直な中間評価」のこともあれば「攻撃的な低評価」のことも
       * ある。後者を緩和材料に数えると、低評価工作を受けている店ほど
       * スコアが下がるという逆転が起きるため、酷評型は除外する。 */
      const midCandid = reviews.filter((r) => {
        const rt = r.rating || 0;
        if (rt < 2 || rt > 4) return false;
        const txt = (r.text || "").trim();
        if (txt.length < 20) return false;
        if (rt <= 2 && reviewHostility(txt).h >= 0.4) return false;
        return true;
      }).length;
      if (midCandid > 0 && score > 0) {
        let f = midCandid >= 2 ? 0.80 : 0.88;
        /* ただし、直近に高評価だけのバーストがある場合は緩和を半分に抑える。
         * 「評価が下がった店に高評価の偽レビューを投入する」という、実証
         * 研究で確認されたパターンでは、本物の中間評価と発注された★5が
         * 同じ店に共存する。中間評価の存在が免罪符にならないようにする。 */
        const bs = byId.burst;
        const layered = bs && bs.included && bs.score >= 70 && bs.detail.allHigh;
        if (layered) f = 1 - (1 - f) * 0.5;
        relief = {
          factor: f,
          note: `分析対象に、本文を伴う★2〜4の率直な評価が${midCandid}件含まれるため、スコアを${Math.round((1 - f) * 100)}%緩和しました(自然なクチコミ分布の兆候)。`
            + (layered ? "ただし高評価だけが短期に集中しているため、緩和幅は半分に抑えています(既存の評価の上に高評価だけを積み増すパターンに該当するため)。" : "")
            + "★1は二極化(お椀型)というサクラ側のパターンにも該当するため、緩和材料には数えていません。",
        };
        score *= f;
      }
      score = clamp(Math.round(score), 0, 100);
    }

    /* --- 文体軸が欠けている場合はスコアを出さない ---
     * 本ツールの判断の中核は本文の分析(A軸)で、重みの約半分を占める。
     * これが1つも採点できない状態で残りのシグナルだけを合成すると、
     * 「評価が高く、関連度上位のクチコミが近接している」という、人気店なら
     * どこでも当てはまる特徴だけでスコアが決まってしまう。実際、外国語の
     * クチコミしか取得できなかった人気店で、健全な店に49点が付いた。
     * 重みの再配分は「一部が欠けたとき」の仕組みであって、中核が丸ごと
     * 無いときに使うものではない。数字を出さず、理由を示して分析不可とする。 */
    const coreText = byId.text_pattern;
    if (totalWeight > 0 && !coreText.included) {
      const foreignHeavy = reviews.filter(
        (r) => (r.text || "").trim() && !isJapanese(r.text)
      ).length;
      return {
        score: null,
        band: null,
        confidence: { level: "low", label: "低", reasons: ["本文を分析できなかった"] },
        relief: null,
        convergence: null,
        checklist: buildChecklist(byId, reviews, recent),
        signals,
        direction: assessDirection(signals, byId),
        recentActivity: recent,
        sampleBias: assessSampleBias(place, reviews),
        sampleSize: reviews.length,
        analyzable: false,
        unanalyzableReason: foreignHeavy >= 2
          ? `取得できたクチコミ${reviews.length}件のうち${foreignHeavy}件が日本語以外のため、本文の分析ができませんでした。本ツールの文章解析は日本語の語彙にもとづいており、外国語のクチコミに当てると、具体的な内容が書かれていても定型文と誤判定してしまいます。誤った結果を出すよりも、判定を控えます。`
          : `本文を分析できる日本語の高評価クチコミが2件に満たないため、スコアを算出できません。判断の中核となる本文の分析ができない状態で、評価の高さや投稿時期だけから判定すると、人気店を誤って疑うことになります。`,
      };
    }

    const band = totalWeight > 0 ? BANDS.find((b) => score <= b.max) : null;
    const confidence = assessConfidence(place, peers, reviews, included.length);
    const checklist = buildChecklist(byId, reviews, recent);
    const direction = assessDirection(signals, byId);

    return {
      score: totalWeight > 0 ? score : null,
      band,
      confidence,
      relief,
      convergence,
      checklist,
      direction,
      signals,
      recentActivity: recent,
      sampleBias: assessSampleBias(place, reviews),
      sampleSize: reviews.length,
      analyzable: totalWeight > 0,
    };
  }

  /* ---- パターンの向き ------------------------------------------------
   * 不自然さが「高評価の側」に出ているのか「低評価の側」に出ているのかを
   * 判定する。両者は操作の方向が正反対で、後者の場合お店は被害を受けて
   * いる側である可能性が高い。同じスコアでも意味がまるで違うため、
   * 数値だけを見て読み違えられないよう必ず添えて表示する。 */
  function assessDirection(signals, byId) {
    const pos = signals.filter((x) => POSITIVE_SIDE_IDS.includes(x.id) && x.included);
    const posW = pos.reduce((a, x) => a + x.weight, 0);
    const posScore = posW > 0 ? pos.reduce((a, x) => a + x.score * (x.weight / posW), 0) : null;
    const neg = byId.negative_attack;
    const negScore = neg && neg.included ? neg.score : null;

    const base = {
      posScore: posScore == null ? null : Math.round(posScore),
      negScore,
      /* 低評価側は本体スコアの一部(重み10%)にしかならず、そのままでは
       * 「本体スコアは低いのに低評価工作は明白」という状態を見落とす。
       * 一定以上なら独立した数値として前面に出す。 */
      showNegativeMeter: negScore != null && negScore >= 40,
    };

    if (negScore == null) {
      return {
        ...base,
        key: "unknown",
        label: "低評価側は判定できていません",
        note: "分析対象に★1〜2のクチコミが2件以上含まれていないため、低評価側の操作(第三者による低評価工作)については判定できていません。表示中のスコアは高評価側のパターンのみを反映しています。",
      };
    }
    const p = posScore == null ? 0 : posScore;

    if (negScore >= 55 && negScore >= p + 15) {
      return {
        ...base,
        key: "negative",
        label: "不自然さは低評価の側に出ています",
        note: "第三者(競合など)による低評価工作の可能性があり、その場合このお店は被害を受けている側です。上の「サクラ的パターン一致度」は主に高評価の水増しを測る指標のため、この状況では低く出ます。数値ではなく、この向きの表示でご判断ください。事実無根の投稿は、プラットフォームへの削除申請の対象になり得ます。",
      };
    }
    if (negScore >= 55 && p >= 45) {
      return {
        ...base,
        key: "both",
        label: "不自然さが高評価・低評価の両側に出ています",
        note: "評価が二極化しており、クチコミ全体が実態を反映していない可能性があります。高評価の水増しと低評価の攻撃が同時に起きている場合のほか、サクラの★5で作られた期待に本物の利用者が幻滅して★1をつけた場合(お椀型)もこの形になります。",
      };
    }
    if (p >= 45) {
      return {
        ...base,
        key: "positive",
        label: "不自然さは高評価の側に出ています",
        note: "店舗側による高評価の水増しと重なるパターンです。低評価クチコミの側には、際立った不自然さは見られません。",
      };
    }
    return {
      ...base,
      key: "none",
      label: "高評価側・低評価側とも際立った偏りなし",
      note: "どちらの方向にも、操作を疑わせる際立ったパターンは見られません。",
    };
  }

  /* ---- 信頼度: 「分析に使えたデータ量」の指標 ------------------------- */
  function assessConfidence(place, peers, reviews, includedCount) {
    const n = reviews.length;
    const hasNewest = newestSubset(reviews).length > 0;
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
    } else if (n >= 5 && peerCount >= 5 && count >= 50 && includedCount >= 6 && hasNewest) {
      level = "high";
      label = "高";
      reasons.push(`クチコミ${n}件(新着順を含む)・周辺比較${peerCount}店舗・総数${count}件を分析`);
    } else {
      level = "mid";
      label = "中";
      reasons.push(`クチコミ${n}件・有効シグナル${includedCount}/8を分析`);
      if (!hasNewest) reasons.push("新着順のクチコミが取得できず、直近の投稿状況を確認できていない");
      if (peerCount < 5) reasons.push("周辺店舗の比較データが不足");
    }
    return { level, label, reasons };
  }

  return {
    analyze, WEIGHTS, SIGNAL_META, SIGNAL_ORDER, POSITIVE_SIDE_IDS, BANDS, AXES,
    /* テスト用に内部関数も公開 */
    _internal: {
      reviewGenericness, reviewHostility, bigramSimilarity, piecewise, isFullNameStyle,
      minWindow, countSpecifics, endingForm, recentActivity, newestSubset,
    },
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Analyzer;
