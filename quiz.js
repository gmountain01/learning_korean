/* =====================================================
   quiz.js — 한국어 교육 QUIZ 앱 메인 로직
   데이터: Claude API (claude-sonnet-4-6) 생성
   저장소: LocalStorage (API 키, 진행 중 세션)
   ===================================================== */

'use strict';

// ─── 상수 ──────────────────────────────────────────────
const LS_API_KEY = 'quiz_api_key';
const LS_CURRENT = 'quiz_current_session';

// ─── 앱 상태 ──────────────────────────────────────────────
const appState = {
  // 교사 설정 단계
  apiKey:   '',
  grade:    '',
  goal:     '',
  domains:  [],

  // Claude API 생성 결과
  rubric:    null,   // [{ criteria, excellent, average, poor }, ...]
  questions: null,   // [{ id, type, domain, prompt, options, answer, ... }, ...]

  // 퀴즈 세션 (화면 6)
  sessionAnswers:     {},
  currentQuestionIdx: 0,
};

// 퀴즈 세션 타임스탬프
let sessionId  = null;
let startedAt  = null;

// ─── Claude API ──────────────────────────────────────────

/**
 * Anthropic API를 브라우저에서 직접 호출한다.
 * 응답 content[0].text에서 JSON을 파싱하여 반환한다.
 */
async function callClaude(systemPrompt, userPrompt) {
  console.log('[debug] apiKey length:', appState.apiKey?.length);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    mode: 'cors',
    headers: {
      'x-api-key': appState.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-calls': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!res.ok) {
    let errMsg = `API 오류 (${res.status})`;
    try {
      const err = await res.json();
      errMsg = err.error?.message || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  // 마크다운 코드블록 제거 후 JSON 파싱
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    throw new Error('AI 응답을 파싱할 수 없습니다. 다시 시도해 주세요.');
  }
}

/**
 * 루브릭을 생성한다. → appState.rubric에 저장
 */
async function generateRubric() {
  const systemPrompt = `너는 한국어 교육 전문가다. 사용자가 제공하는 급수, 학습 목표, 평가 영역을 바탕으로 수행형 문항 채점 루브릭을 생성한다.
반드시 아래 JSON 형식만 반환하라. 다른 텍스트는 절대 출력하지 마라.

{
  "rubric": [
    { "criteria": "과제 완성도", "excellent": "우수 기준을 구체적으로 작성", "average": "보통 기준", "poor": "미흡 기준" },
    { "criteria": "내용 구성", "excellent": "...", "average": "...", "poor": "..." },
    { "criteria": "문법 사용", "excellent": "...", "average": "...", "poor": "..." },
    { "criteria": "어휘 사용", "excellent": "...", "average": "...", "poor": "..." },
    { "criteria": "의사소통 효과", "excellent": "...", "average": "...", "poor": "..." }
  ]
}`;

  const userPrompt = `급수: ${appState.grade}
학습 목표: ${appState.goal}
평가 영역: ${appState.domains.join(', ')}

위 정보에 맞는 수행형 문항 채점 루브릭을 생성해 주세요. 각 기준의 우수/보통/미흡 수준을 해당 급수 학습자 수준에 맞게 구체적으로 작성하세요.`;

  return callClaude(systemPrompt, userPrompt);
}

/**
 * 퀴즈 문항 5개를 생성한다. → appState.questions에 저장
 */
async function generateQuestions() {
  const systemPrompt = `너는 한국어 교육 전문가다. 사용자가 제공하는 급수, 학습 목표, 평가 영역, 루브릭을 바탕으로 한국어 퀴즈 문항 5개를 생성한다.
반드시 아래 JSON 형식만 반환하라. 다른 텍스트는 절대 출력하지 마라.

문항 유형 규칙:
- grammar_mc: 문법 객관식. options 4개, answer는 정답 번호(1~4 정수), scoring_type: "auto"
- grammar_transform: 문장 변형. options는 빈 배열 [], content.word_bank에 단어 목록, answer는 모범답안 문자열, scoring_type: "auto"
- reading_mc: 읽기 객관식. content.passage에 지문 텍스트, options 4개, answer는 정답 번호, scoring_type: "auto"
- listening_mc: 듣기 객관식. content.passage에 대화/지문 텍스트(오디오 대체), options 4개, answer는 정답 번호, scoring_type: "auto"
- performance: 수행형. options는 빈 배열 [], answer: null, scoring_type: "rubric_review", content.passage에 조건 목록(줄바꿈으로 구분)

JSON 스키마:
{
  "questions": [
    {
      "id": "Q001",
      "type": "grammar_mc",
      "domain": "문법",
      "prompt": "지시문. 빈칸이 있을 때는 [ ] 기호를 사용하라.",
      "options": [{"id":1,"text":"선택지1"},{"id":2,"text":"선택지2"},{"id":3,"text":"선택지3"},{"id":4,"text":"선택지4"}],
      "answer": 2,
      "scoring_type": "auto",
      "explanation": "정답 해설 (auto 채점 문항만)",
      "content": { "passage": null, "word_bank": [] }
    }
  ]
}

주의사항:
- 평가 영역에 포함된 도메인에서만 문항 출제
- domain 값은 반드시 "문법", "읽기", "듣기", "쓰기", "말하기" 중 하나
- performance 문항이 있을 때 루브릭 기준을 반영하여 출제
- 학습 목표의 문법/표현을 실제로 활용하는 문항을 만들어라`;

  const rubricText = appState.rubric
    ? JSON.stringify(appState.rubric, null, 2)
    : '(루브릭 없음)';

  const userPrompt = `급수: ${appState.grade}
학습 목표: ${appState.goal}
평가 영역: ${appState.domains.join(', ')}

루브릭:
${rubricText}

위 정보에 맞는 한국어 퀴즈 문항 5개를 생성해 주세요. 학습 목표와 평가 영역을 고루 반영한 실용적인 문항을 만들어주세요.`;

  return callClaude(systemPrompt, userPrompt);
}

// ─── AI 로딩 오버레이 ──────────────────────────────────
function showAILoading(show, msg) {
  const overlay = document.getElementById('ai-loading-overlay');
  const msgEl   = document.getElementById('ai-loading-msg');
  if (!overlay) return;
  if (msgEl && msg) msgEl.textContent = msg;
  overlay.style.display = show ? 'flex' : 'none';
}

// ─── UI 상태 헬퍼 ──────────────────────────────────────────
function showError(msg) {
  const el    = document.getElementById('error-banner');
  const msgEl = document.getElementById('error-message');
  if (!el) return;
  if (msgEl) msgEl.textContent = msg;
  el.style.display = 'block';
}

function hideError() {
  const el = document.getElementById('error-banner');
  if (el) el.style.display = 'none';
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => {
    s.style.display = 'none';
    s.setAttribute('aria-hidden', 'true');
  });
  const target = document.getElementById(id);
  if (target) {
    target.style.display = 'block';
    target.setAttribute('aria-hidden', 'false');
    target.style.opacity = '0';
    requestAnimationFrame(() => {
      target.style.transition = 'opacity 0.2s ease';
      target.style.opacity = '1';
    });
  }
}

// ─── 헤더 단계 뱃지 ────────────────────────────────────
function updateStepBadge(step) {
  const badge = document.getElementById('header-step-badge');
  if (!badge) return;
  if (step < 0) {
    badge.textContent = '';
    badge.style.display = 'none';
    return;
  }
  const labels = ['준비 1/5', '준비 2/5', '준비 3/5', '준비 4/5', '준비 5/5'];
  badge.textContent = labels[step] || '';
  badge.style.display = 'inline';
}

// ─── 화면 1 — API 키 입력 ──────────────────────────────
function initApiKeyScreen() {
  const input     = document.getElementById('input-api-key');
  const btnToggle = document.getElementById('btn-toggle-key');
  const btnNext   = document.getElementById('btn-next-to-grade');

  // localStorage에서 API 키 복원
  const saved = localStorage.getItem(LS_API_KEY);
  if (saved && input) {
    input.value = saved;
    appState.apiKey = saved;
  }

  function updateBtn() {
    if (btnNext) btnNext.disabled = !input?.value.trim();
  }
  updateBtn();

  if (input) {
    input.addEventListener('input', () => {
      appState.apiKey = input.value.trim();
      updateBtn();
    });
  }

  if (btnToggle && input) {
    btnToggle.addEventListener('click', () => {
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btnToggle.textContent = isPassword ? '🙈' : '👁';
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', () => {
      if (!appState.apiKey) return;
      localStorage.setItem(LS_API_KEY, appState.apiKey);
      showScreen('screen-grade');
      updateStepBadge(1);
      // 이전 급수 선택 복원
      document.querySelectorAll('.grade-btn').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.grade === appState.grade);
      });
    });
  }
}

// ─── 화면 2 — 급수 선택 ────────────────────────────────
function initGradeScreen() {
  const btnPrev = document.getElementById('btn-prev-to-api');
  const btnNext = document.getElementById('btn-next-to-goal');

  function updateBtn() {
    if (btnNext) btnNext.disabled = !appState.grade;
  }
  updateBtn();

  document.querySelectorAll('.grade-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.grade-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      appState.grade = btn.dataset.grade;
      updateBtn();
    });
  });

  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      showScreen('screen-api-key');
      updateStepBadge(0);
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', () => {
      if (!appState.grade) return;
      showScreen('screen-goal');
      updateStepBadge(2);
      // 이전 값 복원
      const inputGoal = document.getElementById('input-goal');
      if (inputGoal && appState.goal) inputGoal.value = appState.goal;
      document.querySelectorAll('input[name="domain"]').forEach(cb => {
        cb.checked = appState.domains.includes(cb.value);
      });
      updateGoalNextBtn();
    });
  }
}

// ─── 화면 3 — 학습 목표 + 평가 영역 ──────────────────────
function updateGoalNextBtn() {
  const inputGoal = document.getElementById('input-goal');
  const btnNext   = document.getElementById('btn-next-to-rubric');
  if (!btnNext) return;
  const goal      = inputGoal ? inputGoal.value.trim() : '';
  const anyDomain = [...document.querySelectorAll('input[name="domain"]:checked')].length > 0;
  btnNext.disabled = !goal || !anyDomain;
}

function initGoalScreen() {
  const inputGoal = document.getElementById('input-goal');
  const btnPrev   = document.getElementById('btn-prev-to-grade');
  const btnNext   = document.getElementById('btn-next-to-rubric');

  if (inputGoal) {
    inputGoal.addEventListener('input', () => {
      appState.goal = inputGoal.value.trim();
      updateGoalNextBtn();
    });
  }

  document.querySelectorAll('input[name="domain"]').forEach(cb => {
    cb.addEventListener('change', updateGoalNextBtn);
  });

  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      showScreen('screen-grade');
      updateStepBadge(1);
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', async () => {
      const inputGoalEl = document.getElementById('input-goal');
      appState.goal    = inputGoalEl ? inputGoalEl.value.trim() : '';
      appState.domains = [...document.querySelectorAll('input[name="domain"]:checked')].map(cb => cb.value);

      hideError();
      showAILoading(true, 'Claude AI가 루브릭을 생성 중입니다...');
      try {
        const result = await generateRubric();
        appState.rubric = result.rubric;
        showScreen('screen-rubric');
        updateStepBadge(3);
        renderRubricScreen();
      } catch (err) {
        console.error('[quiz] 루브릭 생성 실패:', err);
        showError('루브릭 생성에 실패했습니다: ' + err.message);
      } finally {
        showAILoading(false);
      }
    });
  }
}

// ─── 화면 4 — 루브릭 검토 ──────────────────────────────
function renderRubricScreen() {
  const container = document.getElementById('rubric-container');
  if (!container || !appState.rubric) return;

  container.innerHTML = '';
  appState.rubric.forEach(item => {
    const card = document.createElement('div');
    card.className = 'rubric-card';
    card.innerHTML = `
      <h3 class="rubric-card-title">${escapeHtml(item.criteria)}</h3>
      <div class="rubric-level-row">
        <span class="rubric-level-label rubric-level-excellent">우수</span>
        <textarea class="rubric-textarea"
          data-criteria="${escapeAttr(item.criteria)}"
          data-level="excellent" rows="2">${escapeHtml(item.excellent)}</textarea>
      </div>
      <div class="rubric-level-row">
        <span class="rubric-level-label rubric-level-average">보통</span>
        <textarea class="rubric-textarea"
          data-criteria="${escapeAttr(item.criteria)}"
          data-level="average" rows="2">${escapeHtml(item.average)}</textarea>
      </div>
      <div class="rubric-level-row">
        <span class="rubric-level-label rubric-level-poor">미흡</span>
        <textarea class="rubric-textarea"
          data-criteria="${escapeAttr(item.criteria)}"
          data-level="poor" rows="2">${escapeHtml(item.poor)}</textarea>
      </div>`;
    container.appendChild(card);
  });
}

function collectRubricEdits() {
  const criteriaMap = {};
  const ordered = [];
  document.querySelectorAll('.rubric-textarea').forEach(ta => {
    const criteria = ta.dataset.criteria;
    const level    = ta.dataset.level;
    if (!criteriaMap[criteria]) {
      criteriaMap[criteria] = { criteria, excellent: '', average: '', poor: '' };
      ordered.push(criteriaMap[criteria]);
    }
    criteriaMap[criteria][level] = ta.value.trim();
  });
  return ordered;
}

function initRubricScreen() {
  const btnRegen  = document.getElementById('btn-regen-rubric');
  const btnAccept = document.getElementById('btn-accept-rubric');

  if (btnRegen) {
    btnRegen.addEventListener('click', async () => {
      hideError();
      showAILoading(true, 'Claude AI가 루브릭을 다시 생성 중입니다...');
      try {
        const result = await generateRubric();
        appState.rubric = result.rubric;
        renderRubricScreen();
      } catch (err) {
        console.error('[quiz] 루브릭 재생성 실패:', err);
        showError('루브릭 재생성에 실패했습니다: ' + err.message);
      } finally {
        showAILoading(false);
      }
    });
  }

  if (btnAccept) {
    btnAccept.addEventListener('click', async () => {
      // 교사 수정 내용 반영
      appState.rubric = collectRubricEdits();

      hideError();
      showAILoading(true, 'Claude AI가 문항을 생성 중입니다...');
      try {
        const result = await generateQuestions();
        appState.questions = result.questions;
        showScreen('screen-questions');
        updateStepBadge(4);
        renderQuestionsScreen();
      } catch (err) {
        console.error('[quiz] 문항 생성 실패:', err);
        showError('문항 생성에 실패했습니다: ' + err.message);
      } finally {
        showAILoading(false);
      }
    });
  }
}

// ─── 화면 5 — 문항 미리보기 ────────────────────────────
function renderQuestionsScreen() {
  const list = document.getElementById('questions-preview-list');
  if (!list || !appState.questions) return;

  const typeLabels = {
    grammar_mc:        '문법 객관식',
    grammar_transform: '문법 변형형',
    reading_mc:        '읽기 객관식',
    listening_mc:      '듣기 객관식',
    performance:       '수행형',
  };

  list.innerHTML = '';
  appState.questions.forEach((q, idx) => {
    const card = document.createElement('div');
    card.className = 'question-preview-card';

    const passageHtml = q.content?.passage
      ? `<div class="preview-passage">${escapeHtml(q.content.passage)}</div>`
      : '';

    const wordBankHtml = q.content?.word_bank?.length
      ? `<p class="preview-wordbank">단어: ${q.content.word_bank.map(w => escapeHtml(w)).join(' / ')}</p>`
      : '';

    let optionsHtml = '';
    if (q.options && q.options.length > 0) {
      optionsHtml = '<ul class="preview-options">';
      q.options.forEach(opt => {
        const isCorrect = opt.id === q.answer;
        optionsHtml += `<li class="${isCorrect ? 'preview-answer' : ''}">
          ${opt.id}. ${escapeHtml(opt.text)}${isCorrect ? ' ✓' : ''}
        </li>`;
      });
      optionsHtml += '</ul>';
    } else if (q.answer) {
      optionsHtml = `<p class="preview-answer-text">모범답안: <strong>${escapeHtml(String(q.answer))}</strong></p>`;
    }

    card.innerHTML = `
      <div class="question-preview-header">
        <span class="preview-qnum">Q${idx + 1}</span>
        <span class="badge badge-${domainClass(q.domain)}">${escapeHtml(q.domain)}</span>
        <span class="preview-type-badge">${escapeHtml(typeLabels[q.type] || q.type)}</span>
      </div>
      ${passageHtml}
      <p class="preview-prompt">${highlightBlank(q.prompt)}</p>
      ${wordBankHtml}
      ${optionsHtml}`;
    list.appendChild(card);
  });
}

function initQuestionsScreen() {
  const btnRegen = document.getElementById('btn-regen-questions');
  const btnStart = document.getElementById('btn-start-quiz');

  if (btnRegen) {
    btnRegen.addEventListener('click', async () => {
      hideError();
      showAILoading(true, 'Claude AI가 문항을 다시 생성 중입니다...');
      try {
        const result = await generateQuestions();
        appState.questions = result.questions;
        renderQuestionsScreen();
      } catch (err) {
        console.error('[quiz] 문항 재생성 실패:', err);
        showError('문항 재생성에 실패했습니다: ' + err.message);
      } finally {
        showAILoading(false);
      }
    });
  }

  if (btnStart) {
    btnStart.addEventListener('click', () => {
      appState.sessionAnswers     = {};
      appState.currentQuestionIdx = 0;
      sessionId  = generateUUID();
      startedAt  = new Date().toISOString();
      localStorage.removeItem(LS_CURRENT);

      showScreen('screen-quiz');
      updateStepBadge(-1);
      renderQuestion(0);
    });
  }
}

// ─── 화면 6 — 퀴즈 풀기 ────────────────────────────────

function renderQuestion(index) {
  const questions = appState.questions;
  if (!questions) return;
  const q = questions[index];
  if (!q) return;

  appState.currentQuestionIdx = index;
  const total = questions.length;

  // 진행 표시
  const progressText = document.getElementById('progress-text');
  const progressBar  = document.getElementById('progress-bar');
  if (progressText) progressText.textContent = `문항 ${index + 1} / ${total}`;
  if (progressBar) { progressBar.value = index + 1; progressBar.max = total; }

  // 도메인 뱃지
  const badge = document.getElementById('domain-badge');
  if (badge) {
    badge.textContent = q.domain;
    badge.className   = `badge badge-${domainClass(q.domain)}`;
  }

  // 문항 렌더링
  const area = document.getElementById('question-area');
  if (!area) return;
  area.innerHTML = '';

  switch (q.type) {
    case 'grammar_mc':        renderGrammarMC(area, q);        break;
    case 'grammar_transform': renderGrammarTransform(area, q); break;
    case 'reading_mc':        renderReadingMC(area, q);        break;
    case 'listening_mc':      renderListeningMC(area, q);      break;
    case 'performance':       renderPerformance(area, q);      break;
    default: area.innerHTML = '<p>지원하지 않는 문항 유형입니다.</p>';
  }

  // 이전/다음/제출 버튼
  const btnPrev   = document.getElementById('btn-prev');
  const btnNext   = document.getElementById('btn-next');
  const btnSubmit = document.getElementById('btn-submit');
  if (btnPrev)   btnPrev.disabled         = index === 0;
  if (btnNext)   btnNext.style.display    = index < total - 1 ? 'inline-flex' : 'none';
  if (btnSubmit) btnSubmit.style.display  = index === total - 1 ? 'inline-flex' : 'none';

  restoreAnswer(q);
  saveCurrentSession();
}

// ─── 문항 유형별 렌더러 ──────────────────────────────────────

function renderGrammarMC(area, q) {
  let html = `<p class="question-prompt">${highlightBlank(q.prompt)}</p>`;
  if (q.content?.passage) {
    html += `<div class="passage-box">${escapeHtml(q.content.passage)}</div>`;
  }
  html += '<div class="options-list" role="radiogroup">';
  q.options.forEach(opt => {
    html += `<button class="option-card" role="radio" aria-checked="false"
               data-option-id="${opt.id}">
               <span class="option-num">${opt.id}</span>
               <span class="option-text">${escapeHtml(opt.text)}</span>
             </button>`;
  });
  html += '</div>';
  area.innerHTML = html;

  area.querySelectorAll('.option-card').forEach(btn => {
    btn.addEventListener('click', () => {
      handleOptionSelect(btn, q.id, parseInt(btn.dataset.optionId, 10));
    });
  });
}

function renderGrammarTransform(area, q) {
  let html = `<p class="question-prompt">${highlightBlank(q.prompt)}</p>`;
  if (q.content?.word_bank?.length > 0) {
    html += '<div class="word-bank">';
    q.content.word_bank.forEach((word, idx) => {
      html += `<button class="word-chip" data-word-index="${idx}">${escapeHtml(word)}</button>`;
    });
    html += '</div>';
  }
  html += `<div class="transform-input-wrap">
    <input type="text" id="transform-input" class="transform-input"
           placeholder="여기에 문장을 입력하세요"
           autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
  </div>
  <p class="hint-text">단어를 모두 사용하여 자연스러운 문장을 만드세요.</p>`;
  area.innerHTML = html;

  // word-chip: 배열 인덱스로 원본 문자열 직접 참조 (HTML 인코딩 우회)
  area.querySelectorAll('.word-chip').forEach((chip, idx) => {
    chip.addEventListener('click', () => {
      insertWord(q.content.word_bank[idx]);
    });
  });

  const input = area.querySelector('#transform-input');
  if (input) {
    input.addEventListener('input', () => handleTextInput(q.id, input.value));
  }
}

function renderReadingMC(area, q) {
  let html = '<div class="reading-layout">';
  if (q.content?.passage) {
    html += `<div class="passage-box reading-passage">${escapeHtml(q.content.passage)}</div>`;
  }
  html += `<div class="reading-question-side">
    <p class="question-prompt">${highlightBlank(q.prompt)}</p>
    <div class="options-list" role="radiogroup">`;
  q.options.forEach(opt => {
    html += `<button class="option-card" role="radio" aria-checked="false"
               data-option-id="${opt.id}">
               <span class="option-num">${opt.id}</span>
               <span class="option-text">${escapeHtml(opt.text)}</span>
             </button>`;
  });
  html += '</div></div></div>';
  area.innerHTML = html;

  area.querySelectorAll('.option-card').forEach(btn => {
    btn.addEventListener('click', () => {
      handleOptionSelect(btn, q.id, parseInt(btn.dataset.optionId, 10));
    });
  });
}

function renderListeningMC(area, q) {
  let html = `<p class="question-prompt">${highlightBlank(q.prompt)}</p>`;
  // 듣기 지문을 텍스트로 표시 (오디오 없이 운영)
  if (q.content?.passage) {
    html += `<div class="passage-box listening-passage">
      <span class="listening-label">📄 지문</span>
      ${escapeHtml(q.content.passage)}
    </div>`;
  }
  html += '<div class="options-list" role="radiogroup">';
  q.options.forEach(opt => {
    html += `<button class="option-card" role="radio" aria-checked="false"
               data-option-id="${opt.id}">
               <span class="option-num">${opt.id}</span>
               <span class="option-text">${escapeHtml(opt.text)}</span>
             </button>`;
  });
  html += '</div>';
  area.innerHTML = html;

  area.querySelectorAll('.option-card').forEach(btn => {
    btn.addEventListener('click', () => {
      handleOptionSelect(btn, q.id, parseInt(btn.dataset.optionId, 10));
    });
  });
}

function renderPerformance(area, q) {
  let html = `<p class="question-prompt">${highlightBlank(q.prompt)}</p>`;
  if (q.content?.passage) {
    const lines = q.content.passage.split('\n').filter(l => l.trim());
    html += '<ul class="performance-conditions">';
    lines.forEach(line => {
      html += `<li>${escapeHtml(line.replace(/^[✓\-\*•]\s*/, ''))}</li>`;
    });
    html += '</ul>';
  }
  html += `<textarea id="performance-input" class="performance-textarea"
             placeholder="자유롭게 의견을 쓰세요..." rows="6"></textarea>
  <p class="sentence-counter" id="sentence-counter">현재 0문장</p>`;
  area.innerHTML = html;

  const textarea = area.querySelector('#performance-input');
  if (textarea) {
    textarea.addEventListener('input', () => handlePerformanceInput(q.id, textarea.value));
  }
}

// ─── 답안 처리 ───────────────────────────────────────────────

function handleOptionSelect(btn, questionId, optionId) {
  const container = btn.closest('.options-list');
  if (container) {
    container.querySelectorAll('.option-card').forEach(card => {
      card.classList.remove('selected');
      card.setAttribute('aria-checked', 'false');
    });
  }
  btn.classList.add('selected');
  btn.setAttribute('aria-checked', 'true');
  appState.sessionAnswers[questionId] = optionId;
  saveCurrentSession();
}

function handleTextInput(questionId, value) {
  appState.sessionAnswers[questionId] = value;
  saveCurrentSession();
}

function handlePerformanceInput(questionId, value) {
  appState.sessionAnswers[questionId] = value;
  const counter = document.getElementById('sentence-counter');
  if (counter) counter.textContent = `현재 ${countSentences(value)}문장`;
  saveCurrentSession();
}

function countSentences(text) {
  if (!text.trim()) return 0;
  const matches = text.match(/[^.!?。！？\n]+[.!?。！？\n]/g);
  return matches ? matches.length : (text.trim() ? 1 : 0);
}

function insertWord(word) {
  const input = document.getElementById('transform-input');
  if (!input) return;
  const pos    = input.selectionStart;
  const before = input.value.slice(0, pos);
  const after  = input.value.slice(pos);
  const sep    = before && !before.endsWith(' ') ? ' ' : '';
  input.value  = before + sep + word + ' ' + after;
  input.focus();

  const q = appState.questions?.[appState.currentQuestionIdx];
  if (q) handleTextInput(q.id, input.value);
}

function restoreAnswer(q) {
  const saved = appState.sessionAnswers[q.id];
  if (saved === undefined) return;

  if (['grammar_mc', 'reading_mc', 'listening_mc'].includes(q.type)) {
    document.querySelectorAll('.option-card').forEach(card => {
      if (parseInt(card.dataset.optionId) === saved) {
        card.classList.add('selected');
        card.setAttribute('aria-checked', 'true');
      }
    });
  } else if (q.type === 'grammar_transform') {
    const input = document.getElementById('transform-input');
    if (input) input.value = saved;
  } else if (q.type === 'performance') {
    const ta = document.getElementById('performance-input');
    if (ta) {
      ta.value = saved;
      const counter = document.getElementById('sentence-counter');
      if (counter) counter.textContent = `현재 ${countSentences(saved)}문장`;
    }
  }
}

// ─── 네비게이션 ─────────────────────────────────────────────

function goToQuestion(index) {
  const questions = appState.questions;
  if (!questions) return;
  if (index < 0 || index >= questions.length) return;
  renderQuestion(index);
}

// ─── 제출 ────────────────────────────────────────────────────

function checkBeforeSubmit() {
  const questions = appState.questions;
  if (!questions) return;

  const unanswered = questions.filter(q => appState.sessionAnswers[q.id] === undefined);
  if (unanswered.length > 0) {
    const modal = document.getElementById('modal-unanswered');
    const msg   = document.getElementById('modal-unanswered-msg');
    if (msg) msg.textContent = `${unanswered.length}개 문항에 답하지 않았습니다. 그래도 제출하시겠습니까?`;
    if (modal) modal.style.display = 'flex';
  } else {
    submitQuiz();
  }
}

function submitQuiz() {
  closeModal('modal-unanswered');
  const questions = appState.questions;
  if (!questions) return;

  const submittedAt = new Date().toISOString();
  const answers = {};

  questions.forEach(q => {
    const value = appState.sessionAnswers[q.id] !== undefined
      ? appState.sessionAnswers[q.id]
      : null;
    let isCorrect = null;
    if (q.scoring_type === 'auto' && value !== null) {
      isCorrect = value === q.answer;
    }
    answers[q.id] = { type: q.type, value, is_correct: isCorrect };
  });

  const autoQs = questions.filter(q => q.scoring_type === 'auto');
  const correct = autoQs.filter(q => answers[q.id].is_correct === true).length;
  const autoScore = {
    correct,
    total_auto: autoQs.length,
    percentage: autoQs.length > 0 ? Math.round(correct / autoQs.length * 100) : 0,
  };

  const session = {
    session_id:   sessionId,
    started_at:   startedAt,
    submitted_at: submittedAt,
    answers,
    auto_score:   autoScore,
  };

  localStorage.removeItem(LS_CURRENT);
  showScreen('screen-result');
  renderResult(session);
}

// ─── 화면 7 — 결과 렌더링 ──────────────────────────────────

function renderResult(session) {
  const questions = appState.questions;
  if (!questions) return;

  const scoreEl = document.getElementById('result-score');
  if (scoreEl) {
    const s = session.auto_score;
    scoreEl.textContent = s.total_auto > 0
      ? `자동 채점: ${s.correct} / ${s.total_auto} 정답 (${s.percentage}%)`
      : '자동 채점 문항 없음';
  }

  const listEl = document.getElementById('result-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  questions.forEach((q, idx) => {
    const ans  = session.answers[q.id];
    const card = document.createElement('div');
    card.className = 'result-card';
    card.style.animationDelay = `${idx * 0.08}s`;

    let statusIcon = '', statusClass = '', statusText = '';
    if (q.scoring_type === 'auto') {
      if (ans?.is_correct === true) {
        statusIcon = '✓'; statusClass = 'correct'; statusText = '정답';
      } else if (ans?.value !== null && ans?.value !== undefined) {
        statusIcon = '✗'; statusClass = 'wrong'; statusText = '오답';
      } else {
        statusIcon = '–'; statusClass = 'pending'; statusText = '미응답';
      }
    } else {
      statusIcon = '⏳'; statusClass = 'pending'; statusText = '교사 채점 대기';
    }

    let answerDetail = '';
    if (q.scoring_type === 'auto' && ans?.is_correct === false) {
      const myOpt   = q.options?.find(o => o.id === ans.value);
      const corrOpt = q.options?.find(o => o.id === q.answer);
      answerDetail = `<p class="result-detail">내 답: ${myOpt ? escapeHtml(myOpt.text) : '미응답'}</p>
                      <p class="result-detail correct-answer">정답: ${corrOpt ? escapeHtml(corrOpt.text) : escapeHtml(String(q.answer))}</p>`;
      if (q.explanation) {
        answerDetail += `<p class="result-explanation">${escapeHtml(q.explanation)}</p>`;
      }
    }

    // 수행형 문항: 루브릭 채점 기준 카드 추가
    let rubricFeedback = '';
    if (q.scoring_type === 'rubric_review' && appState.rubric) {
      rubricFeedback = '<div class="rubric-feedback-card">';
      rubricFeedback += '<p class="rubric-feedback-title">📋 채점 기준</p>';
      appState.rubric.forEach(item => {
        rubricFeedback += `
          <div class="rubric-criteria-row">
            <span class="rubric-criteria-name">${escapeHtml(item.criteria)}</span>
            <div class="rubric-criteria-levels">
              <span class="rubric-level-badge level-excellent">우수: ${escapeHtml(item.excellent)}</span>
              <span class="rubric-level-badge level-average">보통: ${escapeHtml(item.average)}</span>
              <span class="rubric-level-badge level-poor">미흡: ${escapeHtml(item.poor)}</span>
            </div>
          </div>`;
      });
      rubricFeedback += '</div>';
    }

    card.innerHTML = `
      <div class="result-card-header">
        <span class="result-qnum">Q${idx + 1}</span>
        <span class="badge badge-${domainClass(q.domain)}">${escapeHtml(q.domain)}</span>
        <span class="result-status ${statusClass}">${statusIcon} ${escapeHtml(statusText)}</span>
      </div>
      <p class="result-prompt">${escapeHtml(q.prompt.substring(0, 80))}${q.prompt.length > 80 ? '…' : ''}</p>
      ${answerDetail}
      ${rubricFeedback}`;
    listEl.appendChild(card);
  });
}

// ─── LocalStorage ──────────────────────────────────────────

function saveCurrentSession() {
  if (!sessionId) return;
  localStorage.setItem(LS_CURRENT, JSON.stringify({
    session_id:   sessionId,
    started_at:   startedAt,
    answers:      appState.sessionAnswers,
    questionIdx:  appState.currentQuestionIdx,
  }));
}

function resetQuiz() {
  localStorage.removeItem(LS_CURRENT);
  appState.sessionAnswers     = {};
  appState.currentQuestionIdx = 0;
  sessionId = null;
  showScreen('screen-api-key');
  updateStepBadge(0);
}

// ─── 모달 ────────────────────────────────────────────────────

function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.style.display = 'flex';
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.style.display = 'none';
}

// ─── 유틸 ────────────────────────────────────────────────────

function domainClass(domain) {
  const map = {
    '문법': 'grammar', '읽기': 'reading',
    '듣기': 'listening', '쓰기': 'writing', '말하기': 'speaking',
  };
  return map[domain] || 'grammar';
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function highlightBlank(text) {
  if (!text) return '';
  return escapeHtml(text).replace(/\[\s*\]/g, '<span class="blank-marker">____</span>');
}

// ─── DOMContentLoaded 초기화 ─────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // 화면 1(API 키)부터 시작
  showScreen('screen-api-key');
  updateStepBadge(0);
  hideError();

  // 각 화면 초기화
  initApiKeyScreen();
  initGradeScreen();
  initGoalScreen();
  initRubricScreen();
  initQuestionsScreen();

  // 화면 6 — 퀴즈 네비게이션 버튼
  const btnPrev   = document.getElementById('btn-prev');
  const btnNext   = document.getElementById('btn-next');
  const btnSubmit = document.getElementById('btn-submit');
  if (btnPrev)   btnPrev.addEventListener('click',   () => goToQuestion(appState.currentQuestionIdx - 1));
  if (btnNext)   btnNext.addEventListener('click',   () => goToQuestion(appState.currentQuestionIdx + 1));
  if (btnSubmit) btnSubmit.addEventListener('click', checkBeforeSubmit);

  // 미답 경고 모달
  const btnConfirmSubmit = document.getElementById('btn-confirm-submit');
  const btnCancelSubmit  = document.getElementById('btn-cancel-submit');
  if (btnConfirmSubmit) btnConfirmSubmit.addEventListener('click', submitQuiz);
  if (btnCancelSubmit)  btnCancelSubmit.addEventListener('click',  () => closeModal('modal-unanswered'));

  // 화면 7 — 다시 시작
  const btnRestart = document.getElementById('btn-restart');
  if (btnRestart) btnRestart.addEventListener('click', resetQuiz);

  // 에러 배너 재시도 버튼
  const btnRetry = document.getElementById('btn-retry');
  if (btnRetry) btnRetry.addEventListener('click', hideError);
});
