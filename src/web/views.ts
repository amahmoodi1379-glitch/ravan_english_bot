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
          body { 
              background-color: var(--tg-theme-bg-color, #18181b); 
              color: var(--tg-theme-text-color, #ffffff); 
              font-family: sans-serif; 
          }
          .coming-soon-card {
              background: linear-gradient(145deg, #2e2e33, #252529);
              box-shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.5);
          }
      </style>
  </head>
  <body class="flex flex-col items-center justify-center min-h-screen p-6 select-none text-center">
      
      <div class="coming-soon-card w-full max-w-sm p-10 rounded-3xl border border-gray-700/30 flex flex-col items-center space-y-6">
          
          <div class="text-6xl animate-bounce">
              🚧
          </div>

          <h1 class="text-2xl font-bold text-blue-400">
              مینی‌اپ در حال تعمیرات
          </h1>

          <p class="text-lg opacity-80 leading-relaxed">
              داریم روی یه نسخه خیلی خفن‌تر و بدون باگ کار می‌کنیم. <br>
              فعلاً می‌تونید از ربات تلگرام استفاده کنید.
          </p>

          <button onclick="closeApp()" class="px-8 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold shadow-lg transition-all active:scale-95">
              باشه، حله!
          </button>

      </div>

      <script>
          const tg = window.Telegram.WebApp;
          tg.expand();

          function closeApp() {
              tg.close();
          }
      </script>
  </body>
  </html>
  `;
}
