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
      </style>
  </head>
  <body class="flex flex-col items-center justify-center min-h-screen p-4 space-y-6 select-none">
      
      <div class="w-full max-w-md flex justify-between items-center text-sm opacity-80">
          <span>🔥 لایتنر</span>
          <span id="score">...</span>
      </div>

      <div class="card w-full max-w-md p-8 rounded-3xl shadow-2xl text-center space-y-6 border border-gray-700/50">
          <div class="text-xs uppercase tracking-widest opacity-50">Word of the moment</div>
          <h1 id="word" class="text-4xl font-black text-blue-400 drop-shadow-lg">...</h1>
          
          <div id="quiz-area" class="hidden space-y-4">
              <p id="question-text" class="text-lg font-medium opacity-90">...</p>
              <div id="options" class="grid grid-cols-1 gap-3"></div>
          </div>

          <div id="loading" class="animate-pulse flex justify-center py-10">
              <div class="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
      </div>

      <button onclick="loadNext()" class="btn w-full max-w-md py-4 rounded-xl bg-blue-600 font-bold text-white shadow-lg hover:bg-blue-500 hidden" id="next-btn">
          ادامه
      </button>

      <script>
          const tg = window.Telegram.WebApp;
          tg.expand();
          // در نسخه واقعی، این آیدی باید با مکانیزم امنیتی initData چک شود
          const userId = tg.initDataUnsafe?.user?.id || 0; 

          async function loadNext() {
              document.getElementById('loading').classList.remove('hidden');
              document.getElementById('quiz-area').classList.add('hidden');
              document.getElementById('next-btn').classList.add('hidden');
              document.getElementById('word').innerText = '...';

              try {
                  const res = await fetch('/api/leitner/next?uid=' + userId);
                  const data = await res.json();

                  document.getElementById('loading').classList.add('hidden');

                  if (data.status === 'empty') {
                      document.getElementById('word').innerText = '🎉';
                      document.getElementById('question-text').innerText = 'فعلاً هیچ کلمه‌ای برای مرور نداری!';
                      document.getElementById('quiz-area').classList.remove('hidden');
                      return;
                  }

                  document.getElementById('word').innerText = data.word;
                  document.getElementById('question-text').innerText = data.question;
                  
                  const optionsDiv = document.getElementById('options');
                  optionsDiv.innerHTML = '';
                  
                  data.options.forEach((opt, idx) => {
                      const btn = document.createElement('button');
                      btn.className = 'btn w-full py-3 rounded-xl bg-gray-700 hover:bg-gray-600 font-medium border border-gray-600';
                      btn.innerText = opt;
                      btn.onclick = () => checkAnswer(idx, data.id);
                      optionsDiv.appendChild(btn);
                  });

                  document.getElementById('quiz-area').classList.remove('hidden');
              } catch (e) {
                  document.getElementById('word').innerText = 'Error';
              }
          }

          function checkAnswer(selectedIdx, qId) {
              const btns = document.getElementById('options').children;
              for(let btn of btns) {
                  btn.disabled = true;
                  btn.classList.add('opacity-50');
              }
              btns[selectedIdx].classList.remove('bg-gray-700', 'opacity-50');
              btns[selectedIdx].classList.add('bg-blue-600');
              
              // اینجا می‌توانید درخواست POST به سرور بفرستید تا جواب ثبت شود
              // فعلاً فقط دکمه ادامه را نشان می‌دهیم
              document.getElementById('next-btn').classList.remove('hidden');
          }

          loadNext();
      </script>
  </body>
  </html>
  `;
}
