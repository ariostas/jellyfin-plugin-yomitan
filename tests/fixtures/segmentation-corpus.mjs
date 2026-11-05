// Lines with their correct segmentation, written by hand from the Japanese and never from the plugin's output.
//
// The standard is what a learner wants a popup to select. An inflected verb or adjective is one word with the
// auxiliaries Yomitan deinflects (ます, ない, た, て, ている, たい, られる), because the popup explains the whole form.
// Particles are separate. Punctuation is left out of the comparison, so only words are listed. Where Japanese really
// allows two analyses, as with には or a compound the dictionary may or may not list, `or` gives the others, decided
// here in advance. `known` marks a line that fails today and says why it was left: the expected split does not change.
//
// The Sintel lines are from its Japanese subtitles (CC BY 3.0, Blender Foundation, via Wikimedia Commons).
//
// `heldOut` was added once the cost model was finished, with its expected splits written first, and is reported apart
// from `corpus` because the model was never tuned against it. Lines are from the Japanese subtitles of Sita Sings the
// Blues (Nina Paley, CC0) and Sintel, and from a Japanese-language video on Wikimedia Commons (CC BY 3.0).
export const corpus = [
    // Conjugations
    {text: '昨日は学校に行きませんでした', words: '昨日/は/学校/に/行きませんでした'},
    {text: '彼女はケーキを食べられなかった', words: '彼女/は/ケーキ/を/食べられなかった'},
    {text: 'もう帰らなければならない', words: 'もう/帰らなければならない', or: ['もう/帰らなければ/ならない']},
    {text: '早く寝たほうがいいよ', words: '早く/寝た/ほう/が/いい/よ', or: ['早く/寝た/ほうがいい/よ']},
    {text: '何を言っているのか分からない', words: '何/を/言っている/の/か/分からない', or: ['何/を/言っている/のか/分からない']},
    {text: '食べさせられたくなかった', words: '食べさせられたくなかった'},
    {text: '読んでしまいました', words: '読んでしまいました', or: ['読んで/しまいました']},
    {text: '見てみたいです', words: '見てみたい/です', or: ['見て/みたい/です']},

    // Compound verbs. Whether the dictionary lists the compound decides between one word and two.
    {text: '雨が降り始めた', words: '雨/が/降り始めた', or: ['雨/が/降り/始めた']},
    {text: '彼は走り出した', words: '彼/は/走り出した'},
    {text: '手紙を書き終わった', words: '手紙/を/書き終わった', or: ['手紙/を/書き/終わった']},
    {text: '話し合いましょう', words: '話し合いましょう'},
    {text: '思い出せない', words: '思い出せない'},

    // Particles
    {text: '東京から大阪まで新幹線で行く', words: '東京/から/大阪/まで/新幹線/で/行く'},
    {text: '私にはできません', words: '私/に/は/できません', or: ['私/には/できません']},
    {text: '猫と犬とどっちが好き？', words: '猫/と/犬/と/どっち/が/好き'},
    {text: '君のことなんて知らない', words: '君/の/こと/なんて/知らない'},
    {text: 'それでも彼は諦めなかった', words: 'それでも/彼/は/諦めなかった'},

    // Katakana loanwords after hiragana, the case the boundary rule exists for
    {text: 'はコーヒーを飲みます', words: 'は/コーヒー/を/飲みます'},
    {text: 'コンビニでアイスクリームを買った', words: 'コンビニ/で/アイスクリーム/を/買った'},
    {text: 'パソコンのパスワードを忘れました', words: 'パソコン/の/パスワード/を/忘れました'},
    {text: 'サッカーとバスケットボール', words: 'サッカー/と/バスケットボール'},
    {text: '彼女はケーキが好き', words: '彼女/は/ケーキ/が/好き'},
    {text: 'インターネットでニュースを見る', words: 'インターネット/で/ニュース/を/見る'},

    // Mixed scripts, including words that really do cross the kana boundary
    {text: '消しゴムを貸してください', words: '消しゴム/を/貸してください', or: ['消しゴム/を/貸して/ください']},
    {text: 'Tシャツを着ている', words: 'Tシャツ/を/着ている'},
    {text: 'CDを買いにいく', words: 'CD/を/買い/に/いく'},
    {text: 'ヤバい、マジでムカつく', words: 'ヤバい/マジ/で/ムカつく', or: ['ヤバい/マジで/ムカつく']},
    {text: '授業をサボった', words: '授業/を/サボった'},
    // Folded to 言えよ, the potential's imperative, which crosses the boundary. That hid 言え, the same row.
    {text: '早く言えヨ', words: '早く/言え/ヨ'},
    {text: 'ちゃんと書けヨ', words: 'ちゃんと/書け/ヨ'},
    {text: 'スマホの充電が切れた', words: 'スマホ/の/充電/が/切れた'},
    {text: '3Dプリンターで作る', words: '3D/プリンター/で/作る', or: ['3Dプリンター/で/作る']},

    // Names. The names dictionary may hold a whole name or its parts.
    {text: '田中さんは山田先生の生徒です', words: '田中/さん/は/山田/先生/の/生徒/です'},
    {text: '東京タワーに行きたい', words: '東京タワー/に/行きたい', or: ['東京/タワー/に/行きたい']},
    {text: 'ジョンさんはアメリカ人です', words: 'ジョン/さん/は/アメリカ人/です', or: ['ジョン/さん/は/アメリカ/人/です']},
    {text: 'シータとラーマは森へ行った', words: 'シータ/と/ラーマ/は/森/へ/行った'},
    {text: '坂本龍馬は土佐の出身だ', words: '坂本龍馬/は/土佐/の/出身/だ', or: ['坂本/龍馬/は/土佐/の/出身/だ']},

    // Onomatopoeia
    {text: 'ドキドキしてきた', words: 'ドキドキ/してきた', or: ['ドキドキ/して/きた']},
    {text: '雨がザーザー降っている', words: '雨/が/ザーザー/降っている'},
    {text: 'お腹がぺこぺこだ', words: 'お腹/が/ぺこぺこ/だ'},
    {text: 'ふわふわの雲が浮かんでいる', words: 'ふわふわ/の/雲/が/浮かんでいる'},
    {text: 'わくわくするね', words: 'わくわく/する/ね'},

    // Numbers and counters. A digit and its counter read fine together or apart.
    {text: '三人の子供がいる', words: '三人/の/子供/が/いる', or: ['三/人/の/子供/が/いる']},
    {text: 'りんごを5個ください', words: 'りんご/を/5/個/ください', or: ['りんご/を/5個/ください']},
    {text: '駅まで歩いて十分です', words: '駅/まで/歩いて/十分/です'},
    {text: '2024年3月15日に生まれた', words: '2024/年/3/月/15/日/に/生まれた', or: ['2024年/3月/15日/に/生まれた', '2024/年/3月/15日/に/生まれた']},
    {text: '２階建ての家', words: '２階建て/の/家', or: ['２/階建て/の/家']},
    {text: '百万円もする車', words: '百万円/も/する/車', or: ['百万/円/も/する/車']},

    // Song lyrics punctuation
    {text: '♪君の声が聞こえる♪', words: '君/の/声/が/聞こえる'},
    {text: 'ああ…　夢のような…', words: 'ああ/夢/の/ような', or: ['ああ/夢/の/よう/な']},
    {text: 'さよなら、さよなら、また会う日まで', words: 'さよなら/さよなら/また/会う/日/まで'},
    {text: '「どうして？」と彼は聞いた', words: 'どうして/と/彼/は/聞いた'},
    {text: '愛してる　愛してる　君だけを', words: '愛してる/愛してる/君/だけ/を'},
    {text: '走れ！走れ！風のように', words: '走れ/走れ/風/の/ように', or: ['走れ/走れ/風/のように']},

    // Drawn-out endings, which belong to their word. Captions use ー, ～ and 〜, and a trailing っ or vowel.
    {text: 'すみませ～ん！', words: 'すみません'},
    {text: 'もう帰るー', words: 'もう/帰るー'},
    {text: 'あれっ？　変だな〜', words: 'あれっ/変/だ/な'},
    {text: 'ありがと～', words: 'ありがと'},
    {text: '早く行くぞお', words: '早く/行くぞお', or: ['早く/行く/ぞお']},

    // Kanji that subtitles rarely give furigana for
    {text: '憂鬱な気分で薔薇を眺める', words: '憂鬱/な/気分/で/薔薇/を/眺める'},
    {text: '経済成長率が低下している', words: '経済成長率/が/低下している', or: ['経済/成長率/が/低下している', '経済成長/率/が/低下している', '経済成長率/が/低下/している', '経済/成長率/が/低下/している', '経済成長/率/が/低下/している']},
    {text: '醤油と味噌を冷蔵庫に入れた', words: '醤油/と/味噌/を/冷蔵庫/に/入れた'},
    {text: '彼の提案を真剣に検討する', words: '彼/の/提案/を/真剣/に/検討/する', or: ['彼/の/提案/を/真剣/に/検討する']},
    {text: '煙草を吸う人が減少した', words: '煙草/を/吸う/人/が/減少/した', or: ['煙草/を/吸う/人/が/減少した']},

    // Everyday lines
    {text: '今日は天気がいいね', words: '今日/は/天気/が/いい/ね'},
    {text: 'お母さんは台所で料理を作っている', words: 'お母さん/は/台所/で/料理/を/作っている'},
    {text: 'この店のラーメンはとてもおいしい', words: 'この/店/の/ラーメン/は/とても/おいしい'},
    {text: '行ってきます', words: '行ってきます', or: ['行って/きます']},
    {text: 'ありがとうございました', words: 'ありがとうございました'},
    {text: 'そんなこと言わないでよ', words: 'そんな/こと/言わないで/よ', or: ['そんな/こと/言わない/で/よ']},
    {text: '僕は君が好きだ', words: '僕/は/君/が/好き/だ'},
    {text: 'もしかしたら明日は雪が降るかもしれない', words: 'もしかしたら/明日/は/雪/が/降る/かもしれない'},

    // Sintel
    {text: 'この剣には暗い過去が', words: 'この/剣/に/は/暗い/過去/が', or: ['この/剣/には/暗い/過去/が']},
    {text: '多くの罪なき人の血で汚れている', words: '多く/の/罪/なき/人/の/血/で/汚れている', or: ['多く/の/罪なき/人/の/血/で/汚れている']},
    {text: '生きているのが不思議な位じゃ', words: '生きている/の/が/不思議/な/位/じゃ'},
    {text: 'なぜ「門番の地」に来たのかね？', words: 'なぜ/門番/の/地/に/来た/の/か/ね', or: ['なぜ/門番/の/地/に/来た/のか/ね', 'なぜ/門番/の/地/に/来た/の/かね']},
];

// Round one was blind: the model got 12 of 20 at first. It was then improved, so these no longer count as held out, and
// round two below takes their place. A pattern's parentheses list the analyses that are all fine.
export const heldOut = [
    {text: 'シーターは ラーマの妻', words: 'シーター/は/ラーマ/の/妻'},
    {text: 'シーターの父は ジャナカ', words: 'シーター/の/父/は/ジャナカ'},
    {text: 'シーターには名前が沢山ある', words: 'シーター/に/は/名前/が/沢山/ある', or: ['シーター/には/名前/が/沢山/ある']},
    {text: 'シーターのもう１つの名前だ', words: 'シーター/の/もう/１つ/の/名前/だ', or: ['シーター/の/もう/１/つ/の/名前/だ', 'シーター/の/もう１つ/の/名前/だ'], known: 'のもう reads as 飲もう. Only the grammar around it rules that out, and costs see one word at a time.'},
    {text: 'ダシャラタが王位を渡そうとするが', words: 'ダシャラタ/が/王位/を/渡そう/と/する/が', known: 'とする is a dictionary entry, so this is defensible, though ようとする is と + する.'},
    {text: 'カイケーイーが割って入り', words: 'カイケーイー/が/割って入り', or: ['カイケーイー/が/割って/入り']},
    {text: '彼に尽くしたそうで…', words: '彼/に/尽くした/そう/で', or: ['彼/に/尽くしたそう/で']},
    {text: 'ハンター一人だと危険じゃな', words: 'ハンター/一人/だ/と/危険/じゃ/な', or: ['ハンター/一人/だと/危険/じゃ/な']},
    {text: '私は物心ついた時からずっと一人でした', words: '私/は/物心ついた/時/から/ずっと/一人/でした', or: ['私/は/物心/ついた/時/から/ずっと/一人/でした'], known: 'Nothing the Translator matches covers でした, so it comes out で + した.'},
    {text: '探しているんです', words: '探している/ん/です', or: ['探している/んです']},
    {text: '大切な人？', words: '大切/な/人', known: 'JMdict lists 大切な人, so the popup is useful anyway.'},
    {text: '親類かい？', words: '親類/かい'},
    {text: 'すごいな初めて見た、こんなにたくさんネズミがいるんだ', words: 'すごい/な/初めて/見た/こんなに/たくさん/ネズミ/が/いる/ん/だ', or: ['すごい/な/初めて/見た/こんなに/たくさん/ネズミ/が/いる/んだ']},
    {text: '私が発見したらね、みんな大慌てで逃げ出しました', words: '私/が/発見/したら/ね/みんな/大慌て/で/逃げ出しました', or: ['私/が/発見したら/ね/みんな/大慌て/で/逃げ出しました']},
    {text: 'まあ可愛いですよね、一匹一匹の顔はね', words: 'まあ/可愛い/です/よ/ね/一匹/一匹/の/顔/は/ね', or: ['まあ/可愛い/ですよ/ね/一匹/一匹/の/顔/は/ね', 'まあ/可愛い/ですよね/一匹/一匹/の/顔/は/ね', 'まあ/可愛い/です/よね/一匹/一匹/の/顔/は/ね']},
    {text: 'ただ多いんでちょっと気持ち悪いかなと思いますけれど', words: 'ただ/多い/ん/で/ちょっと/気持ち悪い/か/な/と/思います/けれど', or: ['ただ/多い/んで/ちょっと/気持ち悪い/かな/と/思います/けれど', 'ただ/多い/ん/で/ちょっと/気持ち悪い/かな/と/思います/けれど', 'ただ/多い/んで/ちょっと/気持ち悪い/か/な/と/思います/けれど']},
    {text: 'こんなにいっぱいいるとはね', words: 'こんなに/いっぱい/いる/と/は/ね', or: ['こんなに/いっぱい/いる/とは/ね']},
    {text: '夜になると出てくるんだ', words: '夜/に/なる/と/出てくる/ん/だ', or: ['夜/に/なる/と/出てくる/んだ', '夜/に/なると/出てくる/んだ', '夜/に/なると/出てくる/ん/だ', '夜/に/なる/と/出て/くる/ん/だ', '夜/に/なる/と/出て/くる/んだ'], known: 'になると is a JMdict entry, and 出て/くる/んだ is fine. The word boundaries are all real.'},
    {text: 'まああんまり確かにもともと綺麗な場所だという印象はありませんでしたよ', words: 'まあ/あんまり/確かに/もともと/綺麗/な/場所/だ/という/印象/は/ありませんでした/よ'},
    {text: '私自身はドブネズミっていうのは結構可愛いもんだと思うんですけど', words: '私自身/は/ドブネズミ/っていう/の/は/結構/可愛い/もん/だ/と/思う/ん/です/けど', or: ['私/自身/は/ドブネズミ/っていう/の/は/結構/可愛い/もん/だ/と/思う/ん/です/けど', '私/自身/は/ドブネズミ/っていうのは/結構/可愛い/もん/だ/と/思う/んです/けど', '私自身/は/ドブネズミ/っていうのは/結構/可愛い/もん/だ/と/思う/んです/けど', '私/自身/は/ドブネズミ/っていう/の/は/結構/可愛い/もん/だ/と/思う/んです/けど', '私自身/は/ドブネズミ/っていう/の/は/結構/可愛い/もん/だ/と/思う/んです/けど'], known: 'って/いう and もんだ are both reasonable: this expectation was too narrow.'},
];

// Lines from the same sources, expected splits written before the improved model ever saw them.
export const heldOutRoundTwo = [
    {text: 'ダディー　どうしてこんなに長く さまようの？', pattern: 'ダディー/どうして/こんなに/長く/さまよう/の'},
    {text: '私を望むシークはいくらでもいる', pattern: '私/を/望む/シーク/は/(いくら/でも|いくらでも)/いる', known: 'はい is a stronger word than は, and くら fills the gap. Wrong, and only grammar could tell.'},
    {text: 'まだ負けてないけど　弱くなってしまうかも', pattern: 'まだ/負けてない/けど/弱く/(なってしまう|なって/しまう)/かも'},
    {text: 'ダディー　ダディー　帰ってきて', pattern: 'ダディー/ダディー/(帰ってきて|帰って/きて)'},
    {text: 'それだけよ', pattern: '(それだけ|それ/だけ)/よ'},
    {text: 'ハヌマーンと帰るべきだった', pattern: 'ハヌマーン/と/(帰る/べき|帰るべき)/だった'},
    {text: '｢彼が助けに来るわ｣ってさ', pattern: '彼/が/助け/に/来る/わ/(って/さ|ってさ)'},
    {text: '猿に乗って帰れよと　皆安全だから', pattern: '猿/に/乗って/帰れ/よ/と/皆/安全/(だから|だ/から)', known: 'Yomitan reads 帰れよ as one imperative form. The popup still gives 帰る.'},
    {text: '信用してなかったとか？', pattern: '(信用/してなかった|信用してなかった)/とか'},
    {text: 'そうかもね', pattern: '(そう/かも|そうかも)/ね', known: 'そうか is a stronger word than そう, and leaves も alone.'},
    {text: 'いえ　完全に信用してたのよ', pattern: 'いえ/(完全/に|完全に)/(信用/してた|信用してた)/(の/よ|のよ)'},
    {text: '来て欲しかったの', pattern: '来て/欲しかった/の'},
    {text: 'シーター．．．旅でもどう？', pattern: 'シーター/旅/でも/どう'},
    {text: '帰ったばかりよ', pattern: '帰った/ばかり/よ'},
    {text: 'そうか準備しろ', pattern: '(そうか|そう/か)/(準備/しろ|準備しろ)'},
    {text: 'ラクシュマナよ　妻が私の名に傷をつける', pattern: 'ラクシュマナ/よ/妻/が/私/の/名/に/(傷/を/つける|傷をつける)'},
    {text: 'シーターを森に置き去りに', pattern: 'シーター/を/森/に/置き去り/に'},
    {text: '王国には置いておけない', pattern: '王国/(に/は|には)/(置いておけない|置いて/おけない)'},
    {text: 'なるべく内側を歩くようにしましょう', pattern: 'なるべく/内側/を/歩く/(ように/しましょう|ようにしましょう|よう/に/しましょう)'},
    {text: 'さてしばらく歩きまして', pattern: 'さて/しばらく/歩きまして'},
    {text: '２０分ほど経ちますとこのような川辺に出ました', pattern: '(２０/分|２０分)/ほど/経ちます/と/(このような|この/ような|この/よう/な)/川辺/に/出ました'},
    {text: '奥の辺りにお湯が沸いているのが見えます', pattern: '奥/の/辺り/に/お湯/が/沸いている/(の/が|のが)/見えます'},
    {text: 'ここが地獄谷温泉です', pattern: 'ここ/が/(地獄谷/温泉|地獄谷温泉)/です'},
    {text: 'あそこは確か旅館だったと思います', pattern: 'あそこ/は/確か/旅館/だった/と/思います'},
    {text: '日帰り入浴ができるんだそうです', pattern: '日帰り/入浴/が/できる/(ん/だ|んだ)/(そう/です|そうです)'},
    {text: '要するに間欠泉です', pattern: '要するに/間欠泉/です'},
    {text: 'あそこへ行ったことはないんですが', pattern: 'あそこ/へ/行った/こと/は/ない/(ん/です|んです)/が'},
    {text: '栗あんしるこを買いました', pattern: '(栗/あん/しるこ|栗あん/しるこ)/を/買いました', known: 'しるこ loses to しる + こ, because the headword is 汁粉 and hiragana is only its reading.'},
];
