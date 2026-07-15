/*
 * result-reconciler.js
 * -----------------------------------------------------------------------
 * ocr-analyzer.js が返す「生のOCR結果」を受け取り、楽曲マスターDBと突き合わせながら
 * 最終的な入力値を決定する「総合判断」のロジックです。
 *
 *   1. 曲名のファジーマッチを試み、一致度が高ければそれを採用する
 *   2. 一致度が低い(自信が無い)場合は、読み取った「難易度」と「総ノーツ数
 *      (perfect+great+good+bad+missの合計)」から条件に合う楽曲を逆算し、
 *      曲名テキスト・レベルとの近さで最有力候補を選ぶ
 *   3. 曲名が(直接一致・逆算いずれかで)特定できたら、その楽曲の全難易度の
 *      公式ノーツ数と読み取った総ノーツ数を突き合わせ、難易度の読み取りミスも検出する
 *   4. レベルはDB値を優先しつつ、OCR結果と食い違えば警告する
 *   5. 「コンボ数 > 総ノーツ数」「フルコンボなのにコンボ数が総ノーツ数と不一致」など、
 *      物理的にありえない組み合わせを検出し警告する
 *
 * 候補が複数残り自動選択できない場合は、無理に決め打ちせず警告として提示し、
 * OCRの生の値をそのまま残します(誤った自動修正よりも、ユーザーに確認してもらう
 * ほうが安全なため)。
 * -----------------------------------------------------------------------
 */

// 曲名逆算候補に、曲名テキスト・レベルとの近さでスコアを付ける。
// スコアが小さいほど「有力」。曲名の近さを最重視し、レベル一致を補助的に加味する。
function scoreBackCalcCandidate(candidate, ocrTitleText, ocrLevelValue) {
  const titleSim = ocrTitleText ? titleDistanceRatio(ocrTitleText, candidate.music.title) : 1;
  const levelMatch = (ocrLevelValue != null && candidate.diffEntry.playLevel === ocrLevelValue) ? 0 : 1;
  return { ...candidate, titleSim, levelMatch, score: titleSim * 3 + levelMatch };
}

// 難易度・総ノーツ数から楽曲を逆算する。完全一致 → 誤差許容 の順に探索を広げ、
// 複数候補が残る場合は曲名・レベルとの近さでさらに絞り込む。
// 戻り値: { picked: {music, diffEntry} | null, candidates: [...], toleranceUsed: number, ambiguous: boolean }
function backCalculateMusic(diffDbKey, totalNotes, ocrTitleText, ocrLevelValue) {
  let candidates = findCandidatesByDifficultyAndNoteCount(diffDbKey, totalNotes, 0);
  let toleranceUsed = 0;
  if (candidates.length === 0 && totalNotes > 0) {
    candidates = findCandidatesByDifficultyAndNoteCount(diffDbKey, totalNotes, NOTE_COUNT_BACK_CALC_TOLERANCE);
    toleranceUsed = NOTE_COUNT_BACK_CALC_TOLERANCE;
  }
  if (candidates.length === 0) return { picked: null, candidates: [], toleranceUsed, ambiguous: false };
  if (candidates.length === 1) return { picked: candidates[0], candidates, toleranceUsed, ambiguous: false };

  const scored = candidates
    .map(c => scoreBackCalcCandidate(c, ocrTitleText, ocrLevelValue))
    .sort((a, b) => a.score - b.score);

  const clearWinner = scored[0].score <= scored[1].score - 0.3 || scored[0].titleSim <= 0.15;
  return {
    picked: clearWinner ? scored[0] : null,
    candidates: scored,
    toleranceUsed,
    ambiguous: !clearWinner,
  };
}

// raw: analyzeLoadedImage() が返すOCR生データ。
// 戻り値: { data, warnings, reasoning, confidence, meta }
//   data は item.data にそのままマージできる形 (title/level/diff/perfect/great/good/bad/missDetail/totalMiss/combo/musicId)
function reconcileOcrResult(raw) {
  const warnings = [];
  const reasoning = [];

  const bd = raw.breakdown;
  const totalNotes = (bd.perfect || 0) + (bd.great || 0) + (bd.good || 0) + (bd.bad || 0) + (bd.miss || 0);

  let diffCode = raw.difficulty.code;
  let musicId = null;
  let musicTitle = raw.title.ocrText;
  let titleConfident = false;
  let usedBackCalculation = false;

  // --- 1. 曲名の直接マッチ ---
  const directMatch = findBestMatchMusic(raw.title.ocrText);
  if (directMatch) {
    titleConfident = directMatch.distanceRatio <= TITLE_MATCH_CONFIDENT_MAX_NORM_DIST
      || directMatch.distanceAbs <= TITLE_MATCH_CONFIDENT_MAX_ABS_DIST;
  }

  if (titleConfident) {
    musicId = directMatch.music.id;
    musicTitle = directMatch.music.title;
    reasoning.push(`曲名「${musicTitle}」に高い信頼度で一致しました(OCR:「${raw.title.ocrText}」 距離${directMatch.distanceAbs})。`);
  } else {
    // --- 2. 難易度+総ノーツ数からの逆算 ---
    reasoning.push(directMatch
      ? `曲名の一致度が低いため(最有力候補「${directMatch.music.title}」距離${directMatch.distanceAbs})、難易度・総ノーツ数から逆算します。`
      : `曲名が読み取れなかったため、難易度・総ノーツ数から逆算します。`);

    const diffDbKey = getDiffDbKey(diffCode);
    const backCalc = backCalculateMusic(diffDbKey, totalNotes, raw.title.ocrText, raw.level.value);

    if (backCalc.toleranceUsed > 0 && backCalc.candidates.length > 0) {
      reasoning.push(`総ノーツ数の完全一致候補が無かったため、誤差${backCalc.toleranceUsed}まで許容して再探索しました。`);
    }

    if (backCalc.picked) {
      musicId = backCalc.picked.music.id;
      musicTitle = backCalc.picked.music.title;
      usedBackCalculation = true;
      reasoning.push(`難易度(${getDiffLabel(diffCode)})・総ノーツ数(${totalNotes})から「${musicTitle}」を採用しました。`);
    } else if (backCalc.candidates.length > 0) {
      const names = backCalc.candidates.slice(0, 6).map(c => c.music.title).join(' / ');
      reasoning.push(`候補が${backCalc.candidates.length}件あり自動選択できませんでした: ${names}`);
      warnings.push({
        level: 'warn', field: 'title',
        message: `曲名の候補が複数あり自動選択できませんでした(${backCalc.candidates.length}件: ${names})。手動で選んでください。`,
      });
      musicId = directMatch ? directMatch.music.id : null;
      musicTitle = directMatch ? directMatch.music.title : raw.title.ocrText;
    } else {
      reasoning.push('難易度・総ノーツ数に合致する楽曲が見つかりませんでした。');
      warnings.push({
        level: 'warn', field: 'title',
        message: '曲名を自動特定できませんでした。判定内訳や難易度の読み取りに誤りがないか確認のうえ、手動で曲名を選択してください。',
      });
      musicId = directMatch ? directMatch.music.id : null;
      musicTitle = directMatch ? directMatch.music.title : raw.title.ocrText;
    }
  }

  // --- 3. 難易度の整合性チェック (musicIdが決まっていれば、その楽曲の全難易度と
  //         総ノーツ数を突き合わせて、難易度の読み間違いを検出する) ---
  if (musicId && totalNotes > 0) {
    const diffDbKey = getDiffDbKey(diffCode);
    const entries = getDiffEntriesForMusic(musicId);
    const currentEntry = entries.find(e => e.musicDifficulty === diffDbKey);

    if (currentEntry && currentEntry.totalNoteCount !== totalNotes) {
      const altEntry = entries.find(e => e.totalNoteCount === totalNotes && e.musicDifficulty !== diffDbKey);
      if (altEntry) {
        const altCode = getDiffCodeByDbKey(altEntry.musicDifficulty);
        reasoning.push(`「${musicTitle}」の${getDiffLabel(diffCode)}譜面の公式ノーツ数(${currentEntry.totalNoteCount})が読み取った総ノーツ数(${totalNotes})と不一致ですが、${getDiffLabel(altCode)}譜面(${altEntry.totalNoteCount})と一致したため難易度を修正しました。`);
        warnings.push({
          level: 'warn', field: 'difficulty',
          message: `難易度をOCR結果の「${getDiffLabel(diffCode)}」から、総ノーツ数と一致する「${getDiffLabel(altCode)}」に自動修正しました。誤りがないかご確認ください。`,
        });
        diffCode = altCode;
      } else {
        warnings.push({
          level: 'warn', field: 'breakdown',
          message: `判定内訳の合計(総ノーツ数 ${totalNotes})が公式データの${currentEntry.totalNoteCount}件と一致しません。PERFECT/GREAT/GOOD/BAD/MISSの読み取りをご確認ください。`,
        });
      }
    }
  }

  // --- 4. レベルの決定 (DB値を優先し、OCR値と食い違えば警告) ---
  const dbLevel = musicId ? getLevelFromDb(musicId, getDiffDbKey(diffCode)) : null;
  let finalLevel = null;
  if (dbLevel != null) {
    finalLevel = dbLevel;
    if (raw.level.value != null && raw.level.value !== dbLevel) {
      warnings.push({
        level: 'info', field: 'level',
        message: `レベルのOCR結果(${raw.level.value})とDB上の値(${dbLevel})が異なるため、DBの値を採用しました。`,
      });
    }
  } else if (raw.level.value != null) {
    finalLevel = raw.level.value;
    reasoning.push('楽曲を特定できなかったため、レベルはOCRの読み取り値をそのまま使用します。');
  }

  // レベルバッジ内の難易度表記(参考信号)と、難易度バッジ本体の食い違いを検出
  if (raw.level.diffHint && raw.level.diffHint.matched && raw.level.diffHint.code
      && raw.level.diffHint.code !== diffCode) {
    warnings.push({
      level: 'info', field: 'difficulty',
      message: `難易度バッジ(${getDiffLabel(diffCode)})と楽曲レベル表示内の難易度表記(${getDiffLabel(raw.level.diffHint.code)})が食い違っています。`,
    });
  }

  // --- 5. コンボ数・総ノーツ数の整合性チェック ---
  if (totalNotes > 0 && raw.combo.value > totalNotes) {
    warnings.push({
      level: 'error', field: 'combo',
      message: `コンボ数(${raw.combo.value})が総ノーツ数(${totalNotes})を超えています。コンボ数の読み取り範囲に他の数字が写り込んでいないか、判定内訳の読み取りが正しいかご確認ください。`,
    });
  }
  if (totalNotes > 0 && bd.bad === 0 && bd.miss === 0 && raw.combo.value !== totalNotes) {
    warnings.push({
      level: 'warn', field: 'combo',
      message: `BAD・MISSが0件(フルコンボ相当)にもかかわらず、コンボ数(${raw.combo.value})が総ノーツ数(${totalNotes})と一致していません。読み取り結果をご確認ください。`,
    });
  }
  if (raw.combo.ambiguous) {
    warnings.push({
      level: 'info', field: 'combo',
      message: `コンボ数の読み取り範囲内に複数の数字が見つかりました(${raw.combo.groups.join(', ')})。範囲に余計なものが写り込んでいないかご確認ください。`,
    });
  }
  if (!bd.allFound) {
    const missingLabels = ['perfect', 'great', 'good', 'bad', 'miss'].filter(k => !bd.found[k]);
    warnings.push({
      level: 'warn', field: 'breakdown',
      message: `判定内訳の一部の項目(${missingLabels.join(', ')})を認識できませんでした。値をご確認ください。`,
    });
  }

  // --- 信頼度フラグ (UI表示用) ---
  const confidence = {
    title: titleConfident ? 'high' : (musicId ? 'medium' : 'low'),
    difficulty: (raw.difficulty.matched && raw.difficulty.confidence >= OCR_LOW_CONFIDENCE_THRESHOLD) ? 'high' : 'low',
    level: dbLevel != null ? 'high' : (raw.level.value != null ? 'medium' : 'low'),
    breakdown: (bd.allFound && bd.confidence >= OCR_LOW_CONFIDENCE_THRESHOLD) ? 'high' : 'low',
    combo: (!raw.combo.ambiguous && raw.combo.confidence >= OCR_LOW_CONFIDENCE_THRESHOLD) ? 'high' : 'low',
  };

  return {
    data: {
      title: musicTitle,
      level: finalLevel != null ? finalLevel : '',
      diff: diffCode,
      perfect: bd.perfect, great: bd.great, good: bd.good, bad: bd.bad, missDetail: bd.miss,
      totalMiss: bd.good + bd.bad + bd.miss,
      combo: raw.combo.value,
      musicId: musicId,
    },
    warnings,
    reasoning,
    confidence,
    meta: { totalNotes, titleConfident, usedBackCalculation },
  };
}
