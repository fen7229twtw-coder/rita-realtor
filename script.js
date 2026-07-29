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

    let copied = false;
    try {
      await navigator.clipboard.writeText(summary);
      copied = true;
    } catch (err) {
      copied = false;
    }

    showStatus(
      copied
        ? '已複製您的預約資訊，正在開啟 LINE — 請在聊天室長按貼上並傳送給我，即完成預約。'
        : `即將開啟 LINE，請將以下內容複製傳送給我：\n\n${summary}`,
      'success'
    );

    window.open(LINE_URL, '_blank', 'noopener');
  });
}
