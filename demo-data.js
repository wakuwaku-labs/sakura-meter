/* =========================================================================
 * サクラメーター デモデータ (demo-data.js)
 *
 * ここに含まれる店舗・クチコミ・投稿者名はすべて架空のものであり、
 * 実在の店舗・人物とは一切関係ありません。投稿者名は、架空の地名から
 * 作った実在しない氏名・ニックネームです。
 * APIキーなしでアプリの動作を体験するためのサンプルです。
 * ========================================================================= */

/* デモの投稿日時は「今日から何日前か」で定義する。固定日付だと時間が
 * 経つほど内容が不自然になり、「直近の投稿が途絶えている」判定にも
 * 巻き込まれてしまうため。 */
const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

const DEMO_PLACES = [
  {
    id: "demo-001",
    name: "炭火焼肉 花見苑",
    genre: "焼肉",
    area: "東京・架空町",
    address: "東京都架空区花見町1-2-3(架空の住所)",
    rating: 4.8,
    userRatingCount: 342,
    priceLevel: 3,
    demoNote: "平常ペースを大きく超える★5が短期間に集中し、文面も定型的なパターンの例",
    reviews: [
      { rating: 5, author: "花見 太一", publishTime: ago(43),
        text: "最高でした!また行きたいです!" },
      { rating: 5, author: "花見 健二", publishTime: ago(42),
        text: "お肉が美味しかったです。接客が丁寧で雰囲気も良かったです。おすすめです。" },
      { rating: 5, author: "架空 直樹", publishTime: ago(40),
        text: "コスパ最強。間違いないお店です!!" },
      { rating: 5, author: "架空 陽子", publishTime: ago(39),
        text: "美味しかったです。雰囲気が良く接客も丁寧でおすすめです。" },
      { rating: 5, author: "双葉 大輔", publishTime: ago(37),
        text: "大満足!絶対また来ます!" },
      { rating: 5, author: "双葉 美咲", publishTime: ago(35),
        text: "" },
      { rating: 2, author: "からあげ番長", publishTime: ago(505),
        text: "上カルビ(1,980円)を注文しましたが、値段の割に肉質は普通でした。金曜夜は提供まで30分近く待ちます。タレは好みでしたが再訪は迷います。" },
      { rating: 3, author: "週末ごはん帖", publishTime: ago(780),
        text: "ハラミ定食をランチで。味は悪くないけれど、ご飯のおかわりが有料なのが残念。コスパを考えると近くの他店と同じくらいかな。" },
    ],
  },
  {
    id: "demo-002",
    name: "手打ちそば 綾瀬庵",
    genre: "そば",
    area: "東京・架空町",
    address: "東京都架空区綾瀬台4-5-6(架空の住所)",
    rating: 4.3,
    userRatingCount: 187,
    priceLevel: 2,
    demoNote: "具体的な長文クチコミが長期間に分布する健全な例",
    reviews: [
      { rating: 5, author: "そば散歩", publishTime: ago(65),
        text: "鴨せいろ(1,450円)を注文。二八そばは香りが立っていて、鴨汁は柚子がほんのり効いています。昼は行列ですが回転が早く15分ほどで入れました。蕎麦湯がとろとろなのも嬉しい。" },
      { rating: 4, author: "うどん派だけど", publishTime: ago(224),
        text: "天ざるをいただきました。海老天は揚げたてサクサク。ただ、つゆがやや甘めなので好みは分かれるかも。カウンター席があるので一人でも入りやすいです。" },
      { rating: 3, author: "kenji.t", publishTime: ago(388),
        text: "味は確かですが、土日の混雑は覚悟が必要。30分待ちでした。せいろの量がやや少なめなので、大盛(+200円)推奨です。" },
      { rating: 5, author: "月見草", publishTime: ago(607),
        text: "新そばの時期に再訪。香りが段違いでした。店主さんが打ち場で作業する姿が見えるのも良い。粗挽きの十割は数量限定なので開店直後がおすすめ。" },
      { rating: 4, author: "まるまる商店", publishTime: ago(1193),
        text: "かけそばと鯖寿司のセットを注文。出汁が上品で最後まで飲み干しました。店内は狭めなのでベビーカーは難しいかもしれません。" },
      { rating: 5, author: "とおりすがりの麺類好き", publishTime: ago(2121),
        text: "創業からのファンです。先代から味を引き継いだ二代目の細打ちも素晴らしい。海苔が香る花巻そばは冬季限定です。" },
    ],
  },
  {
    id: "demo-003",
    name: "大衆酒場 ゑびす横丁",
    genre: "居酒屋",
    area: "東京・架空町",
    address: "東京都架空区戎町7-8-9(架空の住所)",
    rating: 4.5,
    userRatingCount: 94,
    priceLevel: 2,
    demoNote: "定型文と具体的なクチコミが混在する中間的な例",
    reviews: [
      { rating: 5, author: "戎 一郎", publishTime: ago(93),
        text: "雰囲気が良くて最高のお店です!おすすめ!" },
      { rating: 5, author: "ホッピー好き", publishTime: ago(108),
        text: "ホッピーセット(490円)と煮込み(380円)が看板。もつ煮は味噌ベースでよく煮込まれていて柔らかい。17時前に入れば席に余裕があります。" },
      { rating: 4, author: "架空 千夏", publishTime: ago(150),
        text: "接客が丁寧で美味しかったです。また行きたいです。" },
      { rating: 4, author: "yokocho_walker", publishTime: ago(282),
        text: "ポテサラに燻製卵が乗っていて面白い。焼きとんは1本120円から。隣の常連さんとの距離が近いので、静かに飲みたい人には向かないかも。" },
      { rating: 5, author: "のんべえ日記", publishTime: ago(360),
        text: "コスパ最高!間違いないです!" },
    ],
  },
  {
    id: "demo-004",
    name: "らーめん 轟音",
    genre: "ラーメン",
    area: "東京・架空町",
    address: "東京都架空区轟町2-3-4(架空の住所)",
    rating: 4.6,
    userRatingCount: 1520,
    priceLevel: 1,
    demoNote: "評価は高いが本文が具体的で分布も自然な人気店の例(高評価=サクラではない)",
    reviews: [
      { rating: 5, author: "煮干し中毒", publishTime: ago(46),
        text: "特製中華そば(1,250円)。鶏と煮干しのダブルスープで、麺は自家製の中細ストレート。開店30分前で15人待ちでしたが着丼まではスムーズ。チャーシューは低温調理でしっとり。" },
      { rating: 4, author: "つけ麺しか勝たん", publishTime: ago(178),
        text: "つけ麺を注文。魚介の効いた濃厚スープで麺量は並200g。ただ、スープ割りのポットがカウンターにないので都度お願いする必要があります。" },
      { rating: 5, author: "ramen_log", publishTime: ago(309),
        text: "限定の冷やし煮干しそばが絶品でした。自家製ラー油を途中で入れると味変が楽しめます。券売機は現金のみなので注意。" },
      { rating: 3, author: "行列は苦手", publishTime: ago(476),
        text: "味は良いのですが、土曜昼は50分待ちでした。並ぶ価値はあると思いますが、時間に余裕がない日は避けた方がいいです。" },
      { rating: 5, author: "こってり派", publishTime: ago(764),
        text: "醤油そばは鶏油の甘みとカエシのキレのバランスが見事。海苔増し(100円)推奨。店主さんの所作が丁寧で気持ちのいいお店です。" },
    ],
  },
  {
    id: "demo-005",
    name: "喫茶ふたば",
    genre: "喫茶店",
    area: "東京・架空町",
    address: "東京都架空区双葉町5-6-7(架空の住所)",
    rating: 4.9,
    userRatingCount: 11,
    priceLevel: 1,
    demoNote: "クチコミが少なく信頼度が「低」になる例(開店直後の店など)",
    reviews: [
      { rating: 5, author: "プリン部", publishTime: ago(12),
        text: "プリンが固めで昔ながらの味。カラメルはほろ苦め。" },
      { rating: 5, author: "双葉 恵", publishTime: ago(24),
        text: "落ち着く店内でした。" },
    ],
  },
  {
    id: "demo-006",
    name: "おばんざい ことの葉",
    genre: "和食",
    area: "東京・架空町",
    address: "東京都架空区言葉町8-9-10(架空の住所)",
    rating: 3.7,
    userRatingCount: 58,
    priceLevel: 2,
    demoNote: "平均的な評価水準の例",
    reviews: [
      { rating: 4, author: "白和えの人", publishTime: ago(125),
        text: "お通しの白和えが優しい味。おばんざい3種盛り(880円)は日替わりです。日本酒の品揃えは少なめ。" },
      { rating: 3, author: "kotonoha_fan", publishTime: ago(206),
        text: "味は家庭的で悪くないですが、金曜夜は料理が出てくるまで20分ほどかかりました。" },
      { rating: 4, author: "出汁とごはん", publishTime: ago(410),
        text: "カウンター中心の小さなお店。肉じゃがや大根の煮物など、出汁がしっかりしています。" },
      { rating: 3, author: "ひとり呑み派", publishTime: ago(639),
        text: "静かに飲めるのは良い。ただ全体的に量が少なめで、男性にはやや物足りないかも。" },
    ],
  },
  {
    id: "demo-007",
    name: "Trattoria Sole(トラットリア ソーレ)",
    genre: "イタリアン",
    area: "東京・架空町",
    address: "東京都架空区陽光町3-4-5(架空の住所)",
    rating: 4.7,
    userRatingCount: 210,
    priceLevel: 3,
    demoNote: "文面の使い回しと、フルネーム型アカウントが目立つ例",
    reviews: [
      { rating: 5, author: "陽光 一郎", publishTime: ago(57),
        text: "雰囲気が良くデートにぴったりのお店です。パスタも美味しくてワインも豊富。接客も丁寧でおすすめです。" },
      { rating: 5, author: "陽光 弘", publishTime: ago(50),
        text: "雰囲気が良くデートにおすすめのお店です。パスタが美味しくワインも豊富。接客も丁寧でした。" },
      { rating: 5, author: "架空 京子", publishTime: ago(36),
        text: "記念日に利用しました。最高でした!" },
      { rating: 4, author: "パスタ日和", publishTime: ago(254),
        text: "渡り蟹のトマトクリーム(2,200円)は蟹の出汁が濃厚で美味。ただ席間が狭く、隣の会話が気になります。サービス料10%があるのは事前に知っておきたかった。" },
      { rating: 5, author: "双葉 涼", publishTime: ago(43),
        text: "素敵な時間を過ごせました!!また絶対来ます!!" },
    ],
  },
  {
    id: "demo-008",
    name: "町中華 龍鳳",
    genre: "中華料理",
    area: "東京・架空町",
    address: "東京都架空区龍鳳町6-7-8(架空の住所)",
    rating: 3.6,
    userRatingCount: 128,
    priceLevel: 1,
    demoNote: "具体性のない酷評★1が短期間に集中する例(第三者による低評価工作が疑われる・お店が被害者の側)",
    reviews: [
      { rating: 1, author: "架空 剛", publishTime: ago(4),
        text: "最悪。二度と行きません。" },
      { rating: 1, author: "陽光 誠", publishTime: ago(2),
        text: "接客の態度が最悪でした。ありえない。行く価値なし。" },
      { rating: 1, author: "架空 学", publishTime: ago(1),
        text: "汚いし不衛生。潰れた方がいいと思います。" },
      { rating: 5, author: "町中華探訪", publishTime: ago(156),
        text: "五目焼きそば(880円)は具沢山で麺はパリパリ。土曜の12時半で待ちなしでした。店主のお母さんが気さくで、餃子(6個400円)は皮から手作りだそうです。" },
      { rating: 4, author: "chuka_daisuki", publishTime: ago(303),
        text: "半チャーハンとラーメンのセット(750円)を注文。スープは昔ながらのあっさり醤油です。ただ店内は油の匂いが強いので、服に匂いがつくのが気になる人は注意。" },
    ],
  },
];

/* 実店舗モードでは、Workerが関連度順と新着順をマージして各クチコミに
 * source("relevant" | "newest" | "both")を付ける。デモでも同じ状態を
 * 再現しておかないと、新着順を前提とした分析(直近の投稿状況)がデモで
 * 動かない。投稿日時の新しい5件を新着順で取得できたものとして扱う。 */
DEMO_PLACES.forEach((place) => {
  const byDate = [...place.reviews]
    .map((r, i) => ({ i, t: new Date(r.publishTime).getTime() }))
    .sort((a, b) => b.t - a.t);
  const newestIdx = new Set(byDate.slice(0, 5).map((x) => x.i));
  place.reviews.forEach((r, i) => {
    r.source = newestIdx.has(i) ? (i % 3 === 0 ? "both" : "newest") : "relevant";
  });
  place.reviewSources = {
    hasNewest: true,
    relevantCount: Math.min(place.reviews.length, 5),
    newestCount: Math.min(place.reviews.length, 5),
    mergedCount: place.reviews.length,
  };
});

if (typeof module !== "undefined" && module.exports) module.exports = DEMO_PLACES;
