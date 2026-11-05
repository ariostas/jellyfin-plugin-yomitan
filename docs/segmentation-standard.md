# How to split a line into words

The rules for labelling the segmentation corpus, the lines from real subtitles that `scripts/segmentation/score.mjs`
scores the splitter against. They extend the standard in the header of `tests/fixtures/segmentation-corpus.mjs`, and the
two must agree. The corpus itself is not in the repository: see [CONTRIBUTING.md](../CONTRIBUTING.md#segmentation-corpus).

Every example here is invented. None is quoted from a subtitle.

## The principle

A word is what a learner wants the popup to select: the stretch of text that one dictionary entry explains, as Yomitan
would look it up. When in doubt, ask what someone hovering over the line would want highlighted.

1. **An inflected verb or adjective is one word, with every auxiliary Yomitan deinflects.** Those are, as of the pinned
   Yomitan: ます, ない, た, て, ている and てる, ておく and とく, てしまう, ちゃう and ちまう, たい, たら, たり, ば, ず, ぬ,
   ん for ない, まい, そう, すぎる, なさい, がる, げ, さ, the passive, causative and potential, the volitional and the
   imperative. So 食べさせられなかった, 書いておいた, 寝ちゃった and 高すぎる are one word each. The list is the rules in
   `third_party/yomitan/ext/js/language/ja/japanese-transforms.js`.
2. **Particles are separate words**, and so are the copula and its forms (だ, です, だった, でした, じゃない, だろう,
   でしょう), each one word apart from what comes before.
3. **Punctuation and white space are left out.** They are boundaries, and are never written in a label.
4. **`or` is for a line that really splits two ways**, where a learner would be as well served by either. It is decided
   while labelling, never after looking at what the splitter did.

## Notation

A label is an object with:

| Field | Meaning |
| --- | --- |
| `id` | From `corpus/sample.json`, such as `title-07` |
| `text` | The line exactly as in the sample |
| `words` | The split, words joined with `/`, with no punctuation or spaces |
| `or` | Optional. Other whole splits that are as right |
| `title`, `set` | From the sample. `set` is `dev` or `test` |
| `note` | Optional. Why a hard choice went the way it did |

Inside `words` and `or`:

- `(a|b)` is a choice in one place, as in the fixture's `pattern`: `本当/に` and `本当に` are both fine, so
  `(本当/に|本当に)/嬉しい`. Use a choice for a local ambiguity and `or` for a whole different reading of the line.
- `?word` is not a word, and is left out of scoring: the boundaries inside it do not count, though its edges do. It is
  for laughter, screams, hums, stutter fragments and noise. See [Non-words](#non-words-and-sound-effects).
- `@word` marks a name, and `*word` slang or dialect. They change nothing in the score: they sort errors into kinds.

The words must rebuild the line once its punctuation and spaces are gone, which the scorer checks.

## Rules

### Verbs, adjectives and auxiliaries

- **Subsidiary verbs Yomitan does not deinflect are separate**, with the one-word form as a choice, since the
  dictionary lists some: `(食べて/みる|食べてみる)`, `(持って/くる|持ってくる)`, `(行って/くれた|行ってくれた)`,
  `(書いて/ほしい|書いてほしい)`, `(読んで/あげる|読んであげる)`, `(置いて/ある|置いてある)`. The same for
  `(待って/ください|待ってください)`.
- **Two verbs that make a compound verb** are one word if the dictionary is likely to list it, with the parts as a choice:
  `(泣き出した|泣き/出した)`. 割り込む and 思い出す are plainly words: one word only. A stem and やすい, にくい or
  つつ is the same: `(使い/やすい|使いやすい)`, and after a noun with する, `(練習/しやすい|練習/し/やすい|練習しやすい)`.
- **A prohibitive な** after a verb splits, with the whole as a choice: `(触る/な|触るな)`.
- **A noun with する** may be one word or two: `(勉強/する|勉強する)`, `(電話/してた|電話してた)`.
- **A na-adjective and な** are two words: `静か/な/部屋`. With に they are both fine, `(静か/に|静かに)`, except where
  the stem is not a word on its own, as in 特に and 急に, which are one word.
- **よう, みたい and そう after a word** are their own words with what follows: `(雨/の/よう/だ|雨/の/ようだ)`,
  `(子供/みたい/だ|子供/みたいだ)`. そう after a verb or adjective stem is deinflected and stays on it: `降りそう/だ`.
- **こと, もの, ところ, わけ, はず, つもり** are nouns, separate. `(かも/しれない|かもしれない)` either way, and `かも`
  alone one word.

### Contractions

- **ちゃう, じゃう, ちまう, てる, でる, とく, どく** stay on their verb, since Yomitan deinflects them: `忘れちゃった`,
  `見てる`, `買っとく`.
- **ちゃ and じゃ for ては and では** stay on the verb too: `触っちゃ/だめ`. **なきゃ and なくちゃ** likewise:
  `行かなきゃ`.
- **じゃん, っす and でしょ** are separate words, like the copula they shorten: `いい/じゃん`, `そう/っす`.
- **って** as a quotation or topic marker is a particle: `明日/って/言った`. `(って/いう|っていう)` either way, and
  `という` one word.
- **んだ, んです, のだ, のです**: `(ん/だ|んだ)` either way, since the popup for either is useful.
- **Slang negatives and adjectives** that Yomitan deinflects are one word: `わかんない`, `すげえ`, `うめえ`, `知らねえ`.
- **の cut to ん after a verb** stays on the verb as one word, marked `*`, and what follows is separate: `*見てん/の`,
  `*食べてん/じゃねえ/よ`, `*来てん/の`. A ん that stands for の after a noun or the copula is the ん of `(ん/だ|んだ)`.
- **です cut to す or っす** is separate, like です: `いい/*す/よ`, `そう/*っす`.

### Particles and sentence endings

- **Each particle is a word**: は, が, を, に, で, と, も, の, へ, や, か, ね, よ, な, わ, ぞ, ぜ, さ.
- **Compound particles** go either way: `(と/して|として)`, `(に/よって|によって)`, `(に/よる|による)`,
  `(に/とって|にとって)`, `(と/とも/に|とともに|と/ともに)`, `(と/は/いえ|とはいえ)`. So do `(で/ある|である)` and its
  forms, `(で/あれば|であれば)` and `(で/あって|であって)`.
- **Particles that are words in their own right** are one word: から, まで, より, けど, けれど, のに, ので, しか, だけ,
  ばかり, くらい, ほど, など, なんて, とか, でも (both "but" and "or something"), こそ, さえ, ずつ, なら, かしら, っけ.
- **Adverbs in に** follow the na-adjective rule, both ways where the stem is a word: `(本当/に|本当に)`, `(すぐ/に|すぐに)`,
  `(久々/に|久々に)`. A mimetic and に split: `ぐちゃぐちゃ/に`.
- **Two particles together** split, with the pair as a choice where the dictionary lists it: `(に/は|には)`,
  `(と/は|とは)`, `(で/は|では)`, `(に/も|にも)`. の/は and の/が only split, except in a set phrase the dictionary lists,
  such as `(と/いう/の/は|というのは)`.
- **ても and でも after a verb** split, since Yomitan has no rule for them: `食べて/も`, `読んで/も`.
- **Sentence-final combinations** split, with the pair as a choice: `(よ/ね|よね)`, `(よ/な|よな)`, `(か/な|かな)`,
  `(の/よ|のよ)`, `(わ/よ|わよ)`, `(の/ね|のね)`, `(か/ね|かね)`, `(の/か|のか)`. Three split into single particles, with
  a choice only where a listed pair is inside: `わ/(よ/ね|よね)`. The copula's な before ん or の goes either way:
  `(な/ん/だ|なんだ|な/んだ)`, `(な/の/よ|なのよ|な/のよ)`.
- **Conjunctions written as one** are one word: それでも, だから, でも, じゃあ, それに, だって. `(だ/から|だから)` after a
  noun, where it is the copula and から.

### Names and forms of address

- **A name and さん, くん, ちゃん, 様, 殿, 先生, 先輩, 氏** are two words: `@田中/さん`. A contracted pet name with ちゃん
  built in, which is not the name with a suffix, is one word with the split as a choice: `(@みっちゃん|@みっ/ちゃん)`.
- **A full name** splits into family and given name, with the whole as a choice: `(@山田/@太郎|@山田太郎)`.
- **Kinship words and titles the dictionary lists** are words, not names: お母さん, お兄ちゃん, 社長, 課長.
- **お and ご** stay on the word they honour when the dictionary lists it, as with お茶 and ご飯. Elsewhere, as a choice:
  `(お/仕事|お仕事)`.

### Numbers and counters

- **A number and its counter** are one word or two: `(三人|三/人)`, `(５個|５/個)`. A number of several digits or kanji
  is one word: `２０２６`, `三百五十`.
- **Counted words with their own reading** are one word only: 一人, 二人, 一つ, 二つ, 一日 as ついたち, 二十歳, 一緒.
- **Dates and times** follow the same rule, each part with its counter: `(３月|３/月)/(５日|５/日)`, `(七時|七/時)/半`.
- **Approximation and order** are separate: `三/日/ほど`, `(第一|第/一)`.

### Onomatopoeia and mimetics

- **A mimetic is one word**, repeated or not: ドキドキ, ぐるぐる, ふわっと, じっと, ピカッ.
- **する, と, に and だ after one** are separate: `ドキドキ/する`, `ぐるぐる/と`, `ぺこぺこ/だ`.
- **A sound effect in the dialogue** is a word if the dictionary could list it, as with ドカン or ガチャ, and a non-word
  (`?`) if it is noise, as with ズドドドド.

### Suffixes

- **さ, げ and み after an adjective** stay on it, as Yomitan deinflects さ and げ: `高さ`, `寂しげ`. `(重み|重/み)`.
- **たち, ら, 達, ども** split, with the whole as a choice, since 私たち and 僕ら are dictionary words:
  `(僕/たち|僕たち)`.
- **的, 性, 化, 式, 者, 家, 中** on a kanji word: one word, with the split as a choice: `(現実的|現実/的)`.
- **さん on a job or place**, as in 魚屋さん or 八百屋さん, splits: `魚屋/さん`.

### Compounds

- **A compound the dictionary is likely to list** is one word, with its parts as a choice:
  `(図書館|図書/館)`, `(東京駅|東京/駅)`, `(中学生|中学/生)`.
- **A compound it surely does not list** is its parts: `会社/帰り`, `夏/休み/明け`. When unsure, give both.
- **Katakana compounds** follow the same rule: `(ゲームセンター|ゲーム/センター)`.
- **Yojijukugo and set phrases** are one word: 一石二鳥, 仕方ない, しょうがない, 気をつけて as `(気/を/つけて|気をつけて)`.

### Dialect and old-fashioned speech

The rules above apply to dialect as to the standard, and the word is marked `*`.

- **Kansai negatives in へん and ん** are one word, as Yomitan deinflects them: `*知らへん`, `*行かん`.
- **The copula や** and its forms are separate words, like だ: `*ほんま/*や/で`. `*やねん` splits as `*や/*ねん`, and
  `*やない` and `*やった` are one word each, like じゃない and だった. A character's verbal tic that stands for the copula,
  such as アル, is the same: `好き/*アル/よ`.
- **とる and とった for ておる** in western dialects are one word with the verb, with the split as a choice:
  `(*待っとる|*待っ/*とる)`. Scornful おる after a stem is the same: `(*笑いおって|笑い/*おって)`.
- **Dialect words** are words: `*あかん`, `*めっちゃ`, `*ほんま`, `*おおきに`, `*しんどい`.
- **Kansai て and た forms** of う verbs, which Yomitan deinflects, are one word: `*買うて`, `*言うた`.
- **Old-fashioned forms**: `ござる` and `ございます` are one word, with で before them either way:
  `そう/(で/ござる|でござる)`. `*じゃ` for だ is separate. `ぬ` and `ず` stay on their verb. Yomitan does not deinflect `おる` after
  て as it does いる, so it splits, with the whole as a choice: `(して/*おる|*しておる)`.

### Interjections, stutters and elongations

- **An interjection is one word**, however written, if the dictionary has some form of it: えーっと, あのー, うーん, おい,
  ねえ, and gasps such as あっ, えっ, ハッ, アアッ and エエー.
- **A name drawn out or shouted** is still a name and one word: `@たーなーかー`.
- **A stutter split by punctuation** leaves a fragment that is not a word: `そ、そんな` is `?そ/そんな`. Without the
  comma, `?そ/そんな` all the same.
- **An elongation belongs to its word**: `すごーい`, `待ってー`, `何っ`. A trailing っ or ー is never a word of its own.
- **Repeated words** are each a word: `はい/はい`.

### Non-words and sound effects

Laughter (`?あはは`, `?フフッ`), breathing (`?ハァ`), crying and groans (`?ううっ`), screams with no dictionary form
(`?ぎゃああ`), growls, animal noises (`?ぶもー`), hums and stutter fragments are marked `?`. The splitter is free to
split them however it likes, so a line that is nothing else counts as right whatever it does. Sound notes in brackets,
such as （拍手）, never reach a label: the extractor removes them with speaker labels.

### Mixed script and romaji

- **Latin letters and digits** in a run are one word: `OK`, `ＤＶＤ`, `3D`. A word written with both, which the
  dictionary lists, is one word: `Tシャツ`, `Jポップ`. `(3D/プリンター|3Dプリンター)` as in the fixture.
- **Romaji or English inside a Japanese line** is left as it is: `Thank/you` if a space was there, and the space is a
  boundary anyway.
- **Kanji with inline ruby** never reach a label: the extractor strips the reading, as in 漢字(かんじ).

### What the extractor leaves out

Lines of under four letters, which are nearly all a name, a gasp or one word, never reach the sample. Neither do songs,
speaker labels or sound notes. Text in doubled parentheses, `((…))`, is a voice heard in someone's head, and stays.

## When labelling forces a new decision

Add the rule here with an invented example in the same change, and relabel any line already done that it affects.
