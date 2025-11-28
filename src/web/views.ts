// فایل: src/web/views.ts

export function getMiniAppHtml(): string {
  return `
  <!DOCTYPE html>
  <html lang="fa" dir="rtl">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Ravan English</title>
      <script src="https://telegram.org/js/telegram-web-app.js"></script>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
          body { background-color: var(--tg-theme-bg-color, #18181b); color: var(--tg-theme-text-color, #ffffff); font-family: sans-serif; }
          .card { background-color: var(--tg-theme-secondary-bg-color, #27272a); }
          .btn { transition: all 0.2s; }
          .btn:active { transform: scale(0.95); }
          .fade-in { animation: fadeIn 0.3s ease-in-out; }
          @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      </style>
  </head>
  <body class="flex flex-col items-center justify-center min-h-screen p-4 space-y-6 select-none">
      
      <div class="w-full max-w-md flex justify-between items-center text-sm opacity-80">
          <span>🔥 لایتنر</span>
          <span id="score">...</span>
      </div>

      <div class="card w-full max-w-md p-8 rounded-3xl shadow-2xl text-center space-y-6 border border-gray-700/50 relative overflow-hidden">
          
          <div id="status-area" class="hidden mb-4">
            <div id="status-icon" class="text-6xl drop-shadow-lg"></div>
          </div>

          <div id="quiz-area" class="hidden space-y-6 fade-in">
              <p id="question-text" class="text-2xl font-bold leading-relaxed text-blue-100">...</p>
              
              <div id="options" class="grid grid-cols-1 gap-3"></div>
          </div>

          <div id="loading" class="animate-pulse flex justify-center py-10">
              <div class="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
      </div>

      <button onclick="loadNext()" class="btn w-full max-w-md py-4 rounded-xl bg-blue-600 font-bold text-white shadow-lg hover:bg-blue-500 hidden" id="next-btn">
          ادامه
      </button>

      <script>
          const tg = window.Telegram.WebApp;
          tg.expand();

          const initData = tg.initData; 

          // المنت‌های صفحه
          const els = {
            loading: document.getElementById('loading'),
            quizArea: document.getElementById('quiz-area'),
            statusArea: document.getElementById('status-area'),
            statusIcon: document.getElementById('status-icon'),
            questionText: document.getElementById('question-text'),
            optionsDiv: document.getElementById('options'),
            nextBtn: document.getElementById('next-btn'),
            score: document.getElementById('score')
          };

          async function loadNext() {
              // ریست کردن وضعیت ظاهری
              els.loading.classList.remove('hidden');
              els.quizArea.classList.add('hidden');
              els.statusArea.classList.add('hidden');
              els.nextBtn.classList.add('hidden');

              try {
                  const res = await fetch('/api/leitner/next', {
                      method: 'GET',
                      headers: { 'Authorization': initData }
                  });

                  // مدیریت خطای لایسنس
                  if (res.status === 403) {
                      showStatus('⛔️', 'شما هنوز عضو نشده‌اید.<br>لطفاً کد لایسنس خود را در ربات ارسال کنید.', 'text-red-400');
                      return;
                  }

                  // مدیریت خطای احراز هویت
                  if (res.status === 401) {
                      showStatus('⚠️', 'خطای دسترسی.<br>لطفاً ربات را از تلگرام باز کنید.', 'text-yellow-400');
                      return;
                  }

                  const data = await res.json();
                  els.loading.classList.add('hidden');

                  // اگر کلمه‌ای نبود
                  if (data.status === 'empty') {
                      showStatus('🎉', 'آفرین! فعلاً هیچ کلمه‌ای برای مرور نداری.', 'text-green-400');
                      return;
                  }

                  // نمایش سوال (بدون نمایش کلمه اصلی!)
                  els.questionText.innerText = data.question;
                  els.questionText.className = "text-2xl font-bold leading-relaxed text-blue-100"; // بازنشانی استایل
                  
                  els.optionsDiv.innerHTML = '';
                  data.options.forEach((opt, idx) => {
                      const btn = document.createElement('button');
                      btn.className = 'btn w-full py-4 rounded-xl bg-gray-700 hover:bg-gray-600 font-medium border border-gray-600 text-lg';
                      btn.innerText = opt;
                      btn.onclick = () => checkAnswer(idx, data.id);
                      els.optionsDiv.appendChild(btn);
                  });

                  els.quizArea.classList.remove('hidden');

              } catch (e) {
                  console.error(e);
                  showStatus('❌', 'خطایی رخ داد. لطفا دوباره تلاش کنید.', 'text-red-500');
                  els.nextBtn.innerText = "تلاش مجدد";
                  els.nextBtn.classList.remove('hidden');
              }
          }

          async function checkAnswer(selectedIdx, qId) {
              const options = ['A', 'B', 'C', 'D'];
              const selectedOption = options[selectedIdx];
              const btns = els.optionsDiv.children;

              // قفل کردن دکمه‌ها
              for(let btn of btns) {
                  btn.disabled = true;
                  btn.classList.add('opacity-50');
              }
              
              btns[selectedIdx].classList.remove('opacity-50');
              btns[selectedIdx].innerHTML = '⏳ ...';

              try {
                  const res = await fetch('/api/leitner/answer', {
                      method: 'POST',
                      headers: { 
                          'Content-Type': 'application/json',
                          'Authorization': initData
                      },
                      body: JSON.stringify({
                          questionId: qId,
                          option: selectedOption
                      })
                  });
                  const result = await res.json();

                  if (result.correct) {
                      btns[selectedIdx].classList.remove('bg-gray-700');
                      btns[selectedIdx].classList.add('bg-green-600');
                      btns[selectedIdx].innerText = '✅ Correct!';
                      
                      if (result.xp > 0) {
                          els.score.innerText = '+' + result.xp + ' XP';
                          els.score.classList.add('text-green-400', 'font-bold');
                      }
                  } else {
                      btns[selectedIdx].classList.remove('bg-gray-700');
                      btns[selectedIdx].classList.add('bg-red-600');
                      btns[selectedIdx].innerText = '❌ Wrong';
                      
                      // نمایش جواب درست
                      const correctIdx = options.indexOf(result.correctOption);
                      if (correctIdx !== -1) {
                          btns[correctIdx].classList.remove('opacity-50', 'bg-gray-700');
                          btns[correctIdx].classList.add('bg-green-600', 'ring-2', 'ring-green-400');
                      }
                  }
                  
                  if (result.correct) tg.HapticFeedback.notificationOccurred('success');
                  else tg.HapticFeedback.notificationOccurred('error');

              } catch (e) {
                  btns[selectedIdx].innerText = 'Error ⚠️';
              }
              
              els.nextBtn.innerText = "ادامه";
              els.nextBtn.classList.remove('hidden');
          }

          // تابع کمکی برای نمایش وضعیت‌های خاص (پایان، خطا و...)
          function showStatus(icon, message, colorClass) {
              els.loading.classList.add('hidden');
              els.quizArea.classList.add('hidden');
              
              els.statusIcon.innerText = icon;
              els.statusArea.classList.remove('hidden');
              
              // استفاده از فضای سوال برای نمایش پیام
              els.questionText.innerHTML = message;
              els.questionText.className = "text-lg font-medium " + colorClass;
              els.quizArea.classList.remove('hidden');
              
              // پاک کردن گزینه‌ها
              els.optionsDiv.innerHTML = '';
          }

          loadNext();
      </script>
  </body>
  </html>
  `;
}
