const jobsEl = document.getElementById('jobs');
const logsEl = document.getElementById('logs');

function appendLog(line) {
  logsEl.textContent += line + '\n';
  logsEl.scrollTop = logsEl.scrollHeight;
}

// تنظیم پیش‌فرض زمان روی ۵ دقیقه آینده
const now = new Date();
now.setMinutes(now.getMinutes() + 5);
document.getElementById('runAt').value = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

async function refreshJobs() {
  const jobs = await window.api.listJobs();
  jobsEl.innerHTML = '';
  
  if (jobs.length === 0) {
    jobsEl.innerHTML = '<li style="color:#666;">هیچ وظیفه‌ای ثبت نشده است.</li>';
    return;
  }

  for (const j of jobs) {
    const formattedDate = new Date(j.runAt).toLocaleString('fa-IR');
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <strong>${j.name}</strong><br>
        <small>زمان: ${formattedDate} | مکث دستورات: ${j.slowMo || 500}ms | تاخیر بستن: ${j.closeDelay || 10}s</small>
      </div>
      <div>
        <button class="btn-run" data-run="${j.id}">تست الان</button>
        <button class="btn-del" data-del="${j.id}">حذف</button>
      </div>
    `;
    jobsEl.appendChild(li);
  }

  jobsEl.querySelectorAll('button[data-run]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-run');
      appendLog(`▶️ شروع اجرای دستی: ${id}`);
      await window.api.runOnce(id);
    };
  });

  jobsEl.querySelectorAll('button[data-del]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-del');
      await window.api.deleteJob(id);
      await refreshJobs();
    };
  });
}

document.getElementById('create').onclick = async () => {
  const name = document.getElementById('name').value.trim();
  const runAt = document.getElementById('runAt').value;
  const script = document.getElementById('script').value.trim();
  const slowMo = parseInt(document.getElementById('slowMo').value, 10) || 500;
  const closeDelay = parseInt(document.getElementById('closeDelay').value, 10) || 10;

  if (!runAt) {
    alert('لطفاً تاریخ و ساعت را انتخاب کنید.');
    return;
  }
  if (!script) {
    alert('کد Playwright را وارد کنید.');
    return;
  }

  await window.api.createJob({ name, runAt, script, slowMo, closeDelay });
  appendLog(`✅ کار جدید با موفقیت ثبت شد.`);
  await refreshJobs();
};

window.api.onLog(({ line }) => appendLog(line));

refreshJobs();
