
function transformCodegenScript(rawCode) {
  if (!rawCode || typeof rawCode !== 'string') return '';

  let code = rawCode;

  code = code.replace(/[\uE000-\uF8FF\uFFF0-\uFFFF\u200c\u200b]/g, ' ');

  code = code.replace(/^\s*(import\s+.*?;?|const\s+.*require\('@playwright\/test'\);?)/gm, '');

  const testBodyMatch = code.match(/test\s*\([^,]+,\s*async\s*\(\s*\{[^}]*\}\s*\)\s*=>\s*\{([\s\S]*)\}\s*\);?\s*$/);
  let body = testBodyMatch ? testBodyMatch[1] : code;

  body = body.replace(/page(\d*)\.getByRole\('link',\s*\{\s*name:\s*['"`](.*?)['"`]\s*\}\)/g, (match, pageNum, text) => {
    const p = pageNum ? `page${pageNum}` : 'page';
    
    const cleanText = text.replace(/[0-9۰-۹]/g, '').trim().replace(/\s+/g, ' ');
    const mainKeywords = cleanText.split(' ').filter(w => w.length > 1 && !['واحد', 'پشتیبان', 'نیمسال'].includes(w));
    const keyword = mainKeywords[0] || cleanText;

    return `${p}.locator('a', { hasText: '${keyword}' }).first()`;
  });

  const formattedCode = `module.exports = async ({ page, context, browser, log }) => {
  log('🚀 اجرای گام‌های ضبط‌شده...');
  // تنظیم حداکثر زمان انتظار به ۱۰ ثانیه برای عدم معطلی طولانی
  page.setDefaultTimeout(10000);

${body.trim()}

  log('🏁 تمام مراحل با موفقیت انجام شد.');
};`;

  return formattedCode;
}

module.exports = { transformCodegenScript };
