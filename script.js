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

// 預約表單：整理內容 -> 複製到剪貼簿 -> 開啟LINE聊天
const LINE_URL = 'https://line.me/ti/p/~ritahaiao';
const form = document.getElementById('bookingForm');
const status = document.getElementById('formStatus');

if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = form.name.value.trim();
    const phone = form.phone.value.trim();
    const topic = form.topic.value;
    const time = form.time.value.trim();
    const message = form.message.value.trim();

    const summary =
      `【預約諮詢】\n` +
      `姓名：${name}\n` +
      `電話：${phone}\n` +
      `諮詢項目：${topic}\n` +
      (time ? `方便時段：${time}\n` : '') +
      (message ? `內容：${message}\n` : '');

    let copied = false;
    try {
      await navigator.clipboard.writeText(summary);
      copied = true;
    } catch (err) {
      copied = false;
    }

    status.textContent = copied
      ? '已複製您的預約資訊，即將開啟LINE，請直接貼上（長按畫面選擇「貼上」）並傳送給我。'
      : `已為您準備好預約資訊，即將開啟LINE，請手動輸入以下內容傳送給我：${summary}`;
    status.classList.add('show', 'success');

    window.open(LINE_URL, '_blank', 'noopener');

    form.reset();
  });
}
