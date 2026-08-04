document.getElementById('year').textContent = new Date().getFullYear();

// 手機選單開關
const navToggle = document.getElementById('navToggle');
const navLinks = document.querySelector('.nav-links');
if (navToggle && navLinks) {
  navToggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
    navLinks.style.display = navLinks.classList.contains('open') ? 'flex' : '';
  });
  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      navLinks.classList.remove('open');
      navLinks.style.display = '';
    });
  });
}

/* ===================== 預約系統 ===================== */

const LINE_URL = 'https://line.me/ti/p/~ritahaiao';

// Google 表單作為預約資料庫：送出的預約會直接寫進後台的試算表。
// 用 no-cors 送出，瀏覽器讀不到回應內容，但資料確實會送達。
const GOOGLE_FORM = {
  action: 'https://docs.google.com/forms/d/e/1FAIpQLSdwwoj4_-jKbJa9yn4MAX8BvrHGNrrYY-jKVsxtCc2EOs_XXg/formResponse',
  fields: {
    slot: 'entry.256599324',
    name: 'entry.1167115456',
    phone: 'entry.1521517769',
    intent: 'entry.1664672412',
    detail: 'entry.355478782'
  }
};

// 營業規則
const RULES = {
  startHour: 10,      // 每日最早 10:00
  endHour: 18,        // 最晚一場 17:00–18:00
  workDays: [1, 2, 3, 4, 5], // 週一至週五
  leadHours: 2,       // 至少提前 2 小時預約
  daysAhead: 14       // 開放未來 14 天
};

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

// 以台灣時間為準產生時段，避免使用者裝置時區不同而看到錯誤的可預約時間
function toTaipei(date) {
  return new Date(date.getTime() + TAIPEI_OFFSET_MS);
}

function buildOpenDays(now) {
  const earliest = now.getTime() + RULES.leadHours * 60 * 60 * 1000;
  const tpeNow = toTaipei(now);
  const days = [];

  for (let offset = 0; offset <= RULES.daysAhead; offset += 1) {
    const day = new Date(Date.UTC(
      tpeNow.getUTCFullYear(),
      tpeNow.getUTCMonth(),
      tpeNow.getUTCDate() + offset
    ));
    const weekday = day.getUTCDay();
    if (!RULES.workDays.includes(weekday)) continue;

    const slots = [];
    for (let hour = RULES.startHour; hour < RULES.endHour; hour += 1) {
      // 台灣時間 hour 點 → 對應的實際 UTC 時間
      const utc = new Date(Date.UTC(
        day.getUTCFullYear(),
        day.getUTCMonth(),
        day.getUTCDate(),
        hour - 8
      ));
      if (utc.getTime() < earliest) continue;
      slots.push({
        iso: utc.toISOString(),
        label: `${String(hour).padStart(2, '0')}:00–${String(hour + 1).padStart(2, '0')}:00`
      });
    }

    if (slots.length) {
      days.push({
        label: `${day.getUTCMonth() + 1}/${day.getUTCDate()} 週${WEEKDAY_LABELS[weekday]}`,
        full: `${day.getUTCFullYear()}/${String(day.getUTCMonth() + 1).padStart(2, '0')}/${String(day.getUTCDate()).padStart(2, '0')}（週${WEEKDAY_LABELS[weekday]}）`,
        slots
      });
    }
  }
  return days;
}

const bookingForm = document.getElementById('bookingForm');
const datesEl = document.getElementById('bkDates');
const slotsEl = document.getElementById('bkSlots');
const pickedEl = document.getElementById('bkPicked');
const statusEl = document.getElementById('formStatus');

let openDays = [];
let activeDay = 0;
let picked = null; // { dayLabel, slotLabel }

function renderDates() {
  datesEl.innerHTML = '';
  openDays.forEach((day, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bk-date' + (index === activeDay ? ' active' : '');
    btn.textContent = day.label;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(index === activeDay));
    btn.addEventListener('click', () => {
      activeDay = index;
      renderDates();
      renderSlots();
    });
    datesEl.appendChild(btn);
  });
}

function renderSlots() {
  slotsEl.innerHTML = '';
  const day = openDays[activeDay];
  if (!day) return;
  day.slots.forEach(slot => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isPicked = picked && picked.dayLabel === day.full && picked.slotLabel === slot.label;
    btn.className = 'bk-slot' + (isPicked ? ' picked' : '');
    btn.textContent = slot.label;
    btn.addEventListener('click', () => {
      picked = { dayLabel: day.full, slotLabel: slot.label };
      renderSlots();
      pickedEl.textContent = `已選擇：${day.full} ${slot.label}`;
      pickedEl.classList.add('has-pick');
    });
    slotsEl.appendChild(btn);
  });
}

function showStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = `form-status show ${kind}`;
}

if (bookingForm && datesEl) {
  openDays = buildOpenDays(new Date());

  if (!openDays.length) {
    slotsEl.innerHTML = '<p class="bk-empty">近期時段皆已排滿，請直接加 LINE 與我聯繫。</p>';
  } else {
    renderDates();
    renderSlots();
  }

  bookingForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const name = bookingForm.name.value.trim();
    const phone = bookingForm.phone.value.trim();
    const message = bookingForm.message.value.trim();
    const meetType = bookingForm.querySelector('input[name="meetType"]:checked').value;
    const urgency = bookingForm.querySelector('input[name="urgency"]:checked').value;
    const intents = Array.from(
      bookingForm.querySelectorAll('input[name="intent"]:checked')
    ).map(box => box.value);

    if (!picked) return showStatus('請先在步驟 1 選擇預約時段。', 'error');
    if (!name) return showStatus('請填寫您的稱呼。', 'error');
    if (!/^[0-9+()\-\s]{8,20}$/.test(phone)) return showStatus('電話格式看起來不正確，請再確認。', 'error');
    if (!intents.length) return showStatus('請至少選擇一項諮詢需求。', 'error');

    const summary =
      '【網站預約】\n' +
      `時段：${picked.dayLabel} ${picked.slotLabel}\n` +
      `方式：${meetType}\n` +
      `姓名：${name}\n` +
      `電話：${phone}\n` +
      `需求：${intents.join('、')}\n` +
      `時程：${urgency}` +
      (message ? `\n說明：${message}` : '');

    const submitBtn = bookingForm.querySelector('.submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = '送出中…';

    // 寫進 Google 表單（＝後台試算表）
    const payload = new FormData();
    payload.append(GOOGLE_FORM.fields.slot, `${picked.dayLabel} ${picked.slotLabel}`);
    payload.append(GOOGLE_FORM.fields.name, name);
    payload.append(GOOGLE_FORM.fields.phone, phone);
    payload.append(GOOGLE_FORM.fields.intent, intents.join('、'));
    payload.append(
      GOOGLE_FORM.fields.detail,
      `見面方式：${meetType}｜預計時程：${urgency}` + (message ? `｜需求說明：${message}` : '')
    );

    let sent = false;
    try {
      await fetch(GOOGLE_FORM.action, { method: 'POST', mode: 'no-cors', body: payload });
      sent = true;
    } catch (err) {
      sent = false;
    }

    submitBtn.disabled = false;
    submitBtn.textContent = '確認預約並傳送到 LINE';

    if (!sent) {
      // 送出失敗時不讓客戶白跑一趟，改請他直接用 LINE 聯繫
      try { await navigator.clipboard.writeText(summary); } catch (err) { /* 忽略 */ }
      showStatus(`網路連線不穩，預約未送出。請直接加 LINE 傳送以下內容給我：\n\n${summary}`, 'error');
      return;
    }

    showStatus(
      `預約已送出！\n\n${summary}\n\n我會盡快與您確認。若要即時聯繫，可加我 LINE：ritahaiao`,
      'success'
    );

    bookingForm.reset();
    picked = null;
    pickedEl.textContent = '尚未選擇時段';
    pickedEl.classList.remove('has-pick');
    renderSlots();
  });
}
