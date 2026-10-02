const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { transformCodegenScript } = require('./utils/codeTransformer');

let mainWindow;

let DATA_DIR;
let JOBS_FILE;
let RUNS_DIR;
let SCRIPTS_DIR;

const scheduledTimers = new Map();
const runningJobs = new Set();

const MAX_TIMEOUT = 2_147_000_000;

function ensureDataDirs() {
  DATA_DIR = path.join(app.getPath('userData'), 'data');
  JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
  RUNS_DIR = path.join(DATA_DIR, 'runs');
  SCRIPTS_DIR = path.join(DATA_DIR, 'scripts');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });

  if (!fs.existsSync(JOBS_FILE)) {
    fs.writeFileSync(
      JOBS_FILE,
      JSON.stringify({ jobs: [] }, null, 2),
      'utf8'
    );
  }
}

function loadJobs() {
  try {
    const raw = fs.readFileSync(JOBS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch (error) {
    console.error('خطا در خواندن jobs.json:', error);
    return [];
  }
}

function saveJobs(jobs) {
  fs.writeFileSync(
    JOBS_FILE,
    JSON.stringify({ jobs }, null, 2),
    'utf8'
  );
}

function sendLog(jobId, runId, line) {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    mainWindow.webContents.send('job:log', {
      jobId,
      runId,
      line
    });
  }
}

function getNumber(value, fallback, maxValue) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }

  return Math.min(Math.floor(number), maxValue);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isPathInside(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);

  return (
    relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  );
}

async function runJob(job) {
  if (runningJobs.has(job.id)) {
    const message = `وظیفه «${job.name}» هم‌اکنون در حال اجراست.`;
    sendLog(job.id, null, `⚠️ ${message}`);

    return {
      ok: false,
      error: message
    };
  }

  runningJobs.add(job.id);

  const runId = `${job.id}-${Date.now()}`;
  const runFolder = path.join(RUNS_DIR, runId);

  fs.mkdirSync(runFolder, { recursive: true });

  const logFile = path.join(runFolder, 'run.log');
  fs.writeFileSync(logFile, '', 'utf8');

  function log(message) {
    const line = `[${new Date().toLocaleTimeString('fa-IR')}] ${message}`;

    try {
      fs.appendFileSync(logFile, `${line}\n`, 'utf8');
    } catch (error) {
      console.error('خطا در نوشتن لاگ:', error);
    }

    sendLog(job.id, runId, line);
  }

  const slowMo = getNumber(job.slowMo, 800, 10000);
  const closeDelay = getNumber(job.closeDelay, 15, 86400);

  let browser;
  let outcome;

  log(`🚀 شروع اجرای برنامه: ${job.name}`);
  log(`🐢 مکث بین دستورات: ${slowMo} میلی‌ثانیه`);

  try {
    browser = await chromium.launch({
      headless: false,
      slowMo
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    const scriptPath = path.resolve(job.scriptPath);

    if (!isPathInside(SCRIPTS_DIR, scriptPath)) {
      throw new Error('مسیر فایل اسکریپت خارج از پوشه scripts است.');
    }

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`فایل اسکریپت پیدا نشد: ${scriptPath}`);
    }

    delete require.cache[require.resolve(scriptPath)];

    const scriptFunction = require(scriptPath);

    if (typeof scriptFunction !== 'function') {
      throw new Error(
        'فایل اسکریپت باید یک تابع را با module.exports صادر کند.'
      );
    }

    const result = await scriptFunction({
      page,
      context,
      browser,
      log,
      runFolder
    });

    outcome = {
      ok: true,
      result
    };

    log('✅ اجرای دستورات با موفقیت تمام شد.');
  } catch (error) {
    outcome = {
      ok: false,
      error: String(error?.stack || error)
    };

    log(`❌ خطا در اجرا: ${String(error?.message || error)}`);
  } finally {
    if (browser) {
      if (closeDelay > 0) {
        log(`⏳ مرورگر تا ${closeDelay} ثانیه دیگر باز می‌ماند...`);
        await sleep(closeDelay * 1000);
      }

      try {
        await browser.close();
        log('🚪 مرورگر بسته شد.');
      } catch (error) {
        log(`⚠️ هنگام بستن مرورگر خطا رخ داد: ${error.message}`);
      }
    }

    runningJobs.delete(job.id);
  }

  try {
    fs.writeFileSync(
      path.join(runFolder, 'result.json'),
      JSON.stringify(
        {
          ...outcome,
          jobId: job.id,
          runId,
          finishedAt: new Date().toISOString()
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (error) {
    log(`⚠️ ذخیره نتیجه اجرا ناموفق بود: ${error.message}`);
  }

  return {
    ...outcome,
    runId
  };
}

function scheduleJob(job) {
  const existingTimer = scheduledTimers.get(job.id);

  if (existingTimer) {
    clearTimeout(existingTimer);
    scheduledTimers.delete(job.id);
  }

  if (!job.enabled || !job.runAt) {
    return;
  }

  const targetTime = new Date(job.runAt).getTime();

  if (!Number.isFinite(targetTime)) {
    console.error(`زمان اجرای نامعتبر برای وظیفه ${job.id}`);
    return;
  }

  if (targetTime <= Date.now()) {
    return;
  }

  function armTimer() {
    const remaining = targetTime - Date.now();

    if (remaining <= 0) {
      scheduledTimers.delete(job.id);

      runJob(job).catch(error => {
        console.error(`خطا در اجرای زمان‌بندی‌شده ${job.id}:`, error);
      });

      return;
    }

    const timer = setTimeout(
      armTimer,
      Math.min(remaining, MAX_TIMEOUT)
    );

    scheduledTimers.set(job.id, timer);
  }

  armTimer();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(
    path.join(__dirname, 'renderer', 'index.html')
  );

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// دریافت فهرست کارها
ipcMain.handle('jobs:list', async () => {
  return loadJobs();
});

// ایجاد و زمان‌بندی کار جدید
ipcMain.handle('jobs:create', async (_event, payload = {}) => {
  if (!payload.script || typeof payload.script !== 'string') {
    throw new Error('کد Playwright وارد نشده است.');
  }

  if (!payload.runAt) {
    throw new Error('تاریخ و ساعت اجرا انتخاب نشده است.');
  }

  const parsedRunAt = new Date(payload.runAt);

  if (!Number.isFinite(parsedRunAt.getTime())) {
    throw new Error('تاریخ و ساعت واردشده معتبر نیست.');
  }

  if (parsedRunAt.getTime() <= Date.now()) {
    throw new Error('زمان اجرا باید در آینده باشد.');
  }

  const jobs = loadJobs();
  const id = `job_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2, 8)}`;

  const scriptPath = path.join(SCRIPTS_DIR, `${id}.js`);

  let executableScript;

  try {
    executableScript = transformCodegenScript(payload.script);
  } catch (error) {
    throw new Error(`تبدیل کد Playwright ناموفق بود: ${error.message}`);
  }

  if (!executableScript || !executableScript.trim()) {
    throw new Error('کد تبدیل‌شده خالی است.');
  }

  fs.writeFileSync(scriptPath, executableScript, 'utf8');

  const job = {
    id,
    name:
      typeof payload.name === 'string' && payload.name.trim()
        ? payload.name.trim()
        : 'وظیفه جدید',
    
    runAt: parsedRunAt.toISOString(),
    slowMo: getNumber(payload.slowMo, 800, 10000),
    closeDelay: getNumber(payload.closeDelay, 15, 86400),
    enabled: true,
    scriptPath
  };

  jobs.push(job);
  saveJobs(jobs);
  scheduleJob(job);

  return job;
});


ipcMain.handle('jobs:runOnce', async (_event, jobId) => {
  const job = loadJobs().find(item => item.id === jobId);

  if (!job) {
    throw new Error('کار موردنظر پیدا نشد.');
  }

  return runJob(job);
});


ipcMain.handle('jobs:delete', async (_event, jobId) => {
  const jobs = loadJobs();
  const jobToDelete = jobs.find(item => item.id === jobId);
  const remainingJobs = jobs.filter(item => item.id !== jobId);

  const timer = scheduledTimers.get(jobId);

  if (timer) {
    clearTimeout(timer);
    scheduledTimers.delete(jobId);
  }

  saveJobs(remainingJobs);

  if (jobToDelete?.scriptPath) {
    try {
      const scriptPath = path.resolve(jobToDelete.scriptPath);

      if (isPathInside(SCRIPTS_DIR, scriptPath) && fs.existsSync(scriptPath)) {
        fs.unlinkSync(scriptPath);
      }
    } catch (error) {
      console.error('خطا در حذف فایل اسکریپت:', error);
    }
  }

  return true;
});

app.whenReady().then(() => {
  ensureDataDirs();
  createWindow();


  for (const job of loadJobs()) {
    scheduleJob(job);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  for (const timer of scheduledTimers.values()) {
    clearTimeout(timer);
  }

  scheduledTimers.clear();
});
