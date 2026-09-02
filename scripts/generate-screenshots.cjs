const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TEMP_USER_DATA = path.join(os.tmpdir(), 'zabor_cdp_' + Date.now());
fs.mkdirSync(TEMP_USER_DATA, { recursive: true });

const BASE_OUT = path.resolve(__dirname, '..', 'promo_assets', 'screenshots');
const DIRS = {
  full: path.join(BASE_OUT, '01_full_screens'),
  isolated: path.join(BASE_OUT, '02_isolated_elements'),
  modals: path.join(BASE_OUT, '03_features_and_modals')
};

Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));

const COMMON_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');

:root {
  color-scheme: dark;
  --z-black: 9 9 11;
  --z-app: 19 19 19;
  --z-panel: 22 22 24;
  --z-surface: 34 34 37;
  --z-surface-hi: 42 42 46;
  --z-line: 48 48 53;
  --z-text: 242 243 245;
  --z-muted: 148 155 164;

  --z-primary: 200 30 112;
  --z-primary-hover: 222 33 124;
  --z-primary-active: 173 26 97;
  --z-primary-text: 238 104 169;

  --z-glass-panel: rgba(22, 22, 24, 0.78);
  --z-glass-modal: rgba(22, 22, 24, 0.88);
  --z-glass-slab: rgba(9, 9, 11, 0.72);
  --z-hair: rgba(255, 255, 255, 0.08);
  --z-hair-top: rgba(255, 255, 255, 0.16);
  --z-surf: rgba(255, 255, 255, 0.05);
  --z-surf-hi: rgba(255, 255, 255, 0.09);

  --z-r-panel: 18px;
  --z-r-modal: 20px;
  --z-r-lg: 14px;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  text-transform: lowercase;
  -webkit-font-smoothing: antialiased;
}

body {
  background-color: #131313;
  color: rgb(242, 243, 245);
  overflow: hidden;
  width: 100vw;
  height: 100vh;
}

.transparent-bg body {
  background: transparent !important;
}

.glass-panel {
  background: var(--z-glass-panel);
  border: 1px solid var(--z-hair);
  border-top-color: var(--z-hair-top);
  border-radius: var(--z-r-panel);
  backdrop-filter: blur(24px) saturate(150%);
}

.glass-slab {
  background: var(--z-glass-slab);
  border: 1px solid var(--z-hair);
  border-top-color: var(--z-hair-top);
  border-radius: var(--z-r-panel);
  backdrop-filter: blur(20px) saturate(150%);
}

.glass-modal {
  background: var(--z-glass-modal);
  border: 1px solid var(--z-hair);
  border-top-color: var(--z-hair-top);
  border-radius: var(--z-r-modal);
  backdrop-filter: blur(32px) saturate(150%);
}

.glass-sheet {
  background: var(--z-glass-modal);
  border: 1px solid var(--z-hair);
  border-top-color: var(--z-hair-top);
  border-radius: var(--z-r-lg);
  backdrop-filter: blur(20px) saturate(150%);
}

.glass-field {
  background: var(--z-surf);
  border: 1px solid var(--z-hair);
  border-radius: 12px;
  color: white;
  padding: 12px 16px;
  outline: none;
}

.btn-primary {
  background: rgb(var(--z-primary));
  color: #fff;
  font-weight: 700;
  padding: 12px 24px;
  border-radius: 12px;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.btn-surface {
  background: rgba(34, 34, 37, 0.7);
  color: #fff;
  font-weight: 600;
  padding: 10px 20px;
  border-radius: 12px;
  border: 1px solid var(--z-hair);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.glow-ambient {
  position: absolute;
  width: 800px;
  height: 800px;
  border-radius: 50%;
  background: radial-gradient(circle at center, rgba(200, 30, 112, 0.1) 0%, transparent 70%);
  pointer-events: none;
}

.icon {
  width: 20px;
  height: 20px;
  fill: currentColor;
  display: inline-block;
  vertical-align: middle;
}
`;

const TITLEBAR_HTML = `
<div style="height: 36px; background: rgba(26,26,26,0.95); border-bottom: 1px solid rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: space-between; padding: 0 16px; position: fixed; top: 0; left: 0; right: 0; z-index: 1000;">
  <div style="display: flex; align-items: center; gap: 8px;">
    <div style="width: 10px; height: 10px; border-radius: 50%; background: rgb(var(--z-primary)); box-shadow: 0 0 10px rgb(var(--z-primary));"></div>
    <span style="font-size: 13px; font-weight: 900; letter-spacing: 0.2em; color: rgba(255,255,255,0.4);">zabor</span>
    <span style="font-size: 11px; background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 6px; color: rgba(255,255,255,0.3); margin-left: 8px;">v3.5.3</span>
  </div>
  <div style="display: flex; align-items: center; height: 100%;">
    <div style="width: 48px; height: 100%; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.4);">
      <svg class="icon" style="width: 12px; height: 12px;" viewBox="0 0 256 256"><path d="M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128Z"/></svg>
    </div>
    <div style="width: 48px; height: 100%; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.4);">
      <svg class="icon" style="width: 12px; height: 12px;" viewBox="0 0 256 256"><rect x="32" y="32" width="192" height="192" rx="16" fill="none" stroke="currentColor" stroke-width="24"/></svg>
    </div>
    <div style="width: 48px; height: 100%; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.4);">
      <svg class="icon" style="width: 12px; height: 12px;" viewBox="0 0 256 256"><line x1="200" y1="56" x2="56" y2="200" stroke="currentColor" stroke-width="24" stroke-linecap="round"/><line x1="200" y1="200" x2="56" y2="56" stroke="currentColor" stroke-width="24" stroke-linecap="round"/></svg>
    </div>
  </div>
</div>
`;

const DOCK_HTML = `
<div class="glass-panel" style="position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); padding: 12px 24px; border-radius: 9999px; display: flex; align-items: center; gap: 16px; z-index: 500; background: rgba(22, 22, 24, 0.9);">
  <div style="width: 44px; height: 44px; border-radius: 50%; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; cursor: pointer; color: #fff;">
    <svg class="icon" viewBox="0 0 256 256"><path d="M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176ZM96,64a32,32,0,0,1,64,0v64a32,32,0,0,1-64,0Zm112,64a8,8,0,0,1-8,8,72,72,0,0,1-144,0,8,8,0,0,1,16,0,56,56,0,0,0,112,0A8,8,0,0,1,208,128Zm-72,80v24a8,8,0,0,1-16,0V208a8,8,0,0,1,16,0Z"/></svg>
  </div>
  <div style="width: 44px; height: 44px; border-radius: 50%; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; cursor: pointer; color: #fff;">
    <svg class="icon" viewBox="0 0 256 256"><path d="M232,152a40,40,0,0,1-40,40H176a16,16,0,0,1-16-16V144a16,16,0,0,1,16-16h40V128a88,88,0,0,0-176,0v0h40a16,16,0,0,1,16,16v32a16,16,0,0,1-16,16H64a40,40,0,0,1-40-40V128A104.11,104.11,0,0,1,128,24h0A104.11,104.11,0,0,1,232,128Z"/></svg>
  </div>
  <div style="width: 44px; height: 44px; border-radius: 50%; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; cursor: pointer; color: #fff;">
    <svg class="icon" viewBox="0 0 256 256"><path d="M216,40H40A16,16,0,0,0,24,56V168a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM160,216a8,8,0,0,1-8,8H104a8,8,0,0,1,0-16h48A8,8,0,0,1,160,216Z"/></svg>
  </div>
  <div style="width: 44px; height: 44px; border-radius: 50%; background: rgba(200,30,112,0.15); border: 1px solid rgba(200,30,112,0.4); display: flex; align-items: center; justify-content: center; cursor: pointer; color: rgb(var(--z-primary-text));">
    <svg class="icon" viewBox="0 0 256 256"><path d="M224,128a96,96,0,1,1-96-96A96,96,0,0,1,224,128Zm-32,0a64,64,0,1,0-64,64A64.07,64.07,0,0,0,192,128Z"/></svg>
  </div>
  <div style="height: 24px; width: 1px; background: rgba(255,255,255,0.1); margin: 0 4px;"></div>
  <div style="background: #DA373C; padding: 10px 20px; border-radius: 9999px; font-weight: 700; display: flex; align-items: center; gap: 8px; cursor: pointer; color: #fff; font-size: 13px;">
    <svg class="icon" style="width: 16px; height: 16px;" viewBox="0 0 256 256"><path d="M239.15,148.91l-40-32a16,16,0,0,0-20.65.65l-21.61,19.21A127.38,127.38,0,0,1,99.23,79.11L118.44,57.5a16,16,0,0,0,.65-20.65l-32-40a16,16,0,0,0-22.61-2.22L28.1,28.61A24,24,0,0,0,16,48C16,145,95,224,192,224a24,24,0,0,0,19.39-12.1l33.98-36.38A16,16,0,0,0,239.15,148.91Z"/></svg>
    <span>завершить</span>
  </div>
</div>
`;

const SIDEBAR_HTML = (activeTab = 'channels') => `
<div class="glass-panel" style="width: 280px; height: calc(100vh - 60px); margin-top: 48px; margin-left: 12px; display: flex; flex-direction: column; justify-content: space-between; padding: 16px;">
  <div>
    <div style="display: flex; background: rgba(34,34,37,0.6); padding: 4px; border-radius: 14px; margin-bottom: 20px;">
      <div style="flex: 1; text-align: center; padding: 8px 0; border-radius: 10px; font-size: 13px; font-weight: 700; cursor: pointer; ${activeTab === 'channels' ? 'background: rgb(var(--z-primary)); color: #fff;' : 'color: rgba(255,255,255,0.5);'}">каналы</div>
      <div style="flex: 1; text-align: center; padding: 8px 0; border-radius: 10px; font-size: 13px; font-weight: 700; cursor: pointer; ${activeTab === 'friends' ? 'background: rgb(var(--z-primary)); color: #fff;' : 'color: rgba(255,255,255,0.5);'}">друзья</div>
    </div>

    ${activeTab === 'channels' ? `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; padding: 0 4px;">
        <span style="font-size: 11px; font-weight: 800; letter-spacing: 0.1em; color: rgba(255,255,255,0.4);">голосовые каналы</span>
        <div style="width: 24px; height: 24px; border-radius: 6px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; cursor: pointer; color: rgba(255,255,255,0.7);">
          <svg class="icon" style="width: 14px; height: 14px;" viewBox="0 0 256 256"><path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"/></svg>
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 6px;">
        <div style="background: rgba(200, 30, 112, 0.15); border: 1px solid rgba(200, 30, 112, 0.35); border-radius: 12px; padding: 10px 12px; display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <svg class="icon" style="color: rgb(var(--z-primary));" viewBox="0 0 256 256"><path d="M152,120H136V56h16a8,8,0,0,0,0-16H104a8,8,0,0,0,0,16h16v64H104a8,8,0,0,0,0,16h48a8,8,0,0,0,0-16Zm80,8H216V64a16,16,0,0,0-16-16H56A16,16,0,0,0,40,64v64H24a8,8,0,0,0,0,16H40v48a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V144h16a8,8,0,0,0,0-16Z"/></svg>
            <span style="font-size: 13px; font-weight: 700; color: #fff;">основной чилл</span>
          </div>
          <span style="font-size: 11px; background: rgb(var(--z-primary)); color: #fff; padding: 2px 6px; border-radius: 6px; font-weight: 700;">4/10</span>
        </div>

        <div style="background: rgba(255,255,255,0.03); border-radius: 12px; padding: 10px 12px; display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <svg class="icon" style="color: rgba(255,255,255,0.3);" viewBox="0 0 256 256"><path d="M152,120H136V56h16a8,8,0,0,0,0-16H104a8,8,0,0,0,0,16h16v64H104a8,8,0,0,0,0,16h48a8,8,0,0,0,0-16Zm80,8H216V64a16,16,0,0,0-16-16H56A16,16,0,0,0,40,64v64H24a8,8,0,0,0,0,16H40v48a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V144h16a8,8,0,0,0,0-16Z"/></svg>
            <span style="font-size: 13px; font-weight: 500; color: rgba(255,255,255,0.7);">ночные катки</span>
          </div>
          <span style="font-size: 11px; color: rgba(255,255,255,0.3);">0/10</span>
        </div>
      </div>
    ` : `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; padding: 0 4px;">
        <span style="font-size: 11px; font-weight: 800; letter-spacing: 0.1em; color: rgba(255,255,255,0.4);">в сети — 2</span>
        <button class="btn-primary" style="padding: 4px 10px; font-size: 11px; border-radius: 8px;">+ друг</button>
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px; border-radius: 12px; background: rgba(255,255,255,0.03);">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div style="width: 36px; height: 36px; border-radius: 50%; background: #3B82F6; display: flex; align-items: center; justify-content: center; font-weight: 800;">A</div>
            <div>
              <div style="font-size: 13px; font-weight: 700; color: #fff;">alex_pro</div>
              <div style="font-size: 11px; color: #23A559;">в сети</div>
            </div>
          </div>
          <button class="btn-surface" style="padding: 6px 12px; font-size: 11px; border-radius: 8px;">позвать</button>
        </div>
      </div>
    `}
  </div>

  <div class="glass-slab" style="padding: 10px 12px; border-radius: 14px; display: flex; align-items: center; justify-content: space-between;">
    <div style="display: flex; align-items: center; gap: 10px;">
      <div style="width: 38px; height: 38px; border-radius: 50%; background: #8B5CF6; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 15px; color: #fff;">V</div>
      <div>
        <div style="font-size: 13px; font-weight: 700; color: #fff;">vnkdevelop</div>
        <div style="font-size: 10px; color: rgba(255,255,255,0.4);">нажмите, чтобы скопировать</div>
      </div>
    </div>
    <div style="display: flex; align-items: center; gap: 6px;">
      <div style="width: 30px; height: 30px; border-radius: 8px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.7); cursor: pointer;">
        <svg class="icon" style="width: 14px; height: 14px;" viewBox="0 0 256 256"><path d="M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176Z"/></svg>
      </div>
      <div style="width: 30px; height: 30px; border-radius: 8px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.7); cursor: pointer;">
        <svg class="icon" style="width: 14px; height: 14px;" viewBox="0 0 256 256"><path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Z"/></svg>
      </div>
    </div>
  </div>
</div>
`;

const PAGES = {
  // FULL SCREENS
  '01_login_screen': `
    <!DOCTYPE html><html><head><style>${COMMON_CSS}</style></head>
    <body>
      ${TITLEBAR_HTML}
      <div class="glow-ambient" style="top: 20%; left: 50%; transform: translate(-50%, -50%);"></div>
      <div style="width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center;">
        <div class="glass-modal" style="width: 420px; padding: 36px 32px; display: flex; flex-direction: column; gap: 24px; z-index: 10;">
          <div style="text-align: center;">
            <div style="display: inline-flex; align-items: center; justify-content: center; width: 56px; height: 56px; border-radius: 18px; background: rgba(200, 30, 112, 0.15); border: 1px solid rgba(200,30,112,0.4); margin-bottom: 12px;">
              <div style="width: 24px; height: 24px; border-radius: 50%; background: rgb(var(--z-primary)); box-shadow: 0 0 16px rgb(var(--z-primary));"></div>
            </div>
            <h1 style="font-size: 26px; font-weight: 900; letter-spacing: -0.02em;">zabor</h1>
            <p style="font-size: 13px; color: rgba(255,255,255,0.4); margin-top: 4px;">легковесный голосовой клиент нового поколения</p>
          </div>

          <div style="display: flex; flex-direction: column; gap: 16px;">
            <div>
              <label style="font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.5); display: block; margin-bottom: 6px;">логин</label>
              <input class="glass-field" style="width: 100%;" value="vnkdevelop" />
            </div>
            <div>
              <label style="font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.5); display: block; margin-bottom: 6px;">пароль</label>
              <input class="glass-field" type="password" style="width: 100%;" value="••••••••••••" />
            </div>
            <button class="btn-primary" style="width: 100%; padding: 14px; font-size: 14px; margin-top: 8px;">продолжить</button>
          </div>
        </div>
      </div>
    </body></html>
  `,

  '02_create_profile_crop': `
    <!DOCTYPE html><html><head><style>${COMMON_CSS}</style></head>
    <body>
      ${TITLEBAR_HTML}
      <div style="width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center;">
        <div class="glass-modal" style="width: 440px; padding: 32px; display: flex; flex-direction: column; gap: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h2 style="font-size: 18px; font-weight: 800;">обрезка аватара</h2>
            <div style="color: rgba(255,255,255,0.4); cursor: pointer;">✕</div>
          </div>
          <div style="display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 20px 0;">
            <div style="width: 140px; height: 140px; border-radius: 50%; background: #8B5CF6; border: 3px solid rgb(var(--z-primary)); display: flex; align-items: center; justify-content: center; font-size: 48px; font-weight: 900; box-shadow: 0 0 30px rgba(200,30,112,0.35);">
              V
            </div>
            <p style="font-size: 12px; color: rgba(255,255,255,0.4);">поддерживаются JPG, PNG и анимированные GIF</p>
          </div>
          <div>
            <label style="font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.5); display: block; margin-bottom: 6px;">отображаемое имя</label>
            <input class="glass-field" style="width: 100%;" value="vnkdevelop" />
          </div>
          <div style="display: gap: 12px;">
            <button class="btn-primary" style="width: 100%;">сохранить профиль</button>
          </div>
        </div>
      </div>
    </body></html>
  `,

  '03_voice_room_idle': `
    <!DOCTYPE html><html><head><style>${COMMON_CSS}</style></head>
    <body>
      ${TITLEBAR_HTML}
      <div style="display: flex; width: 100vw; height: 100vh; position: relative;">
        ${SIDEBAR_HTML('channels')}

        <div style="flex: 1; margin-top: 48px; padding: 24px; display: flex; flex-direction: column; position: relative;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
            <div style="display: flex; align-items: center; gap: 12px;">
              <h1 style="font-size: 20px; font-weight: 800;">основной чилл</h1>
              <span style="font-size: 12px; background: rgba(35, 165, 89, 0.15); color: #23A559; padding: 4px 10px; border-radius: 9999px; font-weight: 700; border: 1px solid rgba(35, 165, 89, 0.3);">прямое p2p соединение</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: #23A559; font-weight: 700;">
              <span style="width: 8px; height: 8px; border-radius: 50%; background: #23A559;"></span>
              <span>пинг 14 мс</span>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; flex: 1; max-height: calc(100vh - 200px);">
            <div class="glass-panel" style="background: #8B5CF6; border-radius: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; border: none;">
              <div style="width: 80px; height: 80px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 900;">V</div>
              <div style="position: absolute; bottom: 16px; background: rgba(9,9,11,0.8); padding: 6px 16px; border-radius: 9999px; font-size: 13px; font-weight: 700; border: 1px solid rgba(255,255,255,0.1);">vnkdevelop (вы)</div>
            </div>
            <div class="glass-panel" style="background: #3B82F6; border-radius: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; border: none;">
              <div style="width: 80px; height: 80px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 900;">A</div>
              <div style="position: absolute; bottom: 16px; background: rgba(9,9,11,0.8); padding: 6px 16px; border-radius: 9999px; font-size: 13px; font-weight: 700;">alex_pro</div>
            </div>
            <div class="glass-panel" style="background: #EC4899; border-radius: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; border: none;">
              <div style="width: 80px; height: 80px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 900;">D</div>
              <div style="position: absolute; bottom: 16px; background: rgba(9,9,11,0.8); padding: 6px 16px; border-radius: 9999px; font-size: 13px; font-weight: 700;">daria_art</div>
            </div>
            <div class="glass-panel" style="background: #10B981; border-radius: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; border: none;">
              <div style="width: 80px; height: 80px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 900;">M</div>
              <div style="position: absolute; bottom: 16px; background: rgba(9,9,11,0.8); padding: 6px 16px; border-radius: 9999px; font-size: 13px; font-weight: 700;">misha</div>
            </div>
          </div>
        </div>
      </div>
      ${DOCK_HTML}
    </body></html>
  `,

  '04_voice_room_speaking_active': `
    <!DOCTYPE html><html><head><style>${COMMON_CSS}</style></head>
    <body>
      ${TITLEBAR_HTML}
      <div style="display: flex; width: 100vw; height: 100vh; position: relative;">
        ${SIDEBAR_HTML('channels')}

        <div style="flex: 1; margin-top: 48px; padding: 24px; display: flex; flex-direction: column; position: relative;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
            <div style="display: flex; align-items: center; gap: 12px;">
              <h1 style="font-size: 20px; font-weight: 800;">основной чилл</h1>
              <span style="font-size: 12px; background: rgba(200, 30, 112, 0.15); color: rgb(var(--z-primary-text)); padding: 4px 10px; border-radius: 9999px; font-weight: 700; border: 1px solid rgba(200,30,112,0.3);">silero vad активен</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: #23A559; font-weight: 700;">
              <span style="width: 8px; height: 8px; border-radius: 50%; background: #23A559;"></span>
              <span>пинг 12 мс</span>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; flex: 1; max-height: calc(100vh - 200px);">
            <div class="glass-panel" style="background: #8B5CF6; border-radius: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; border: 3px solid #23A559; box-shadow: 0 0 30px rgba(35, 165, 89, 0.45);">
              <div style="width: 80px; height: 80px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 900;">V</div>
              <div style="position: absolute; bottom: 16px; background: #23A559; color: #fff; padding: 6px 16px; border-radius: 9999px; font-size: 13px; font-weight: 800;">
                vnkdevelop • говорит
              </div>
            </div>
            <div class="glass-panel" style="background: #3B82F6; border-radius: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; border: none;">
              <div style="width: 80px; height: 80px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 900;">A</div>
              <div style="position: absolute; bottom: 16px; background: rgba(9,9,11,0.8); padding: 6px 16px; border-radius: 9999px; font-size: 13px; font-weight: 700;">alex_pro</div>
            </div>
            <div class="glass-panel" style="background: #EC4899; border-radius: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; border: none;">
              <div style="width: 80px; height: 80px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 900;">D</div>
              <div style="position: absolute; bottom: 16px; background: rgba(9,9,11,0.8); padding: 6px 16px; border-radius: 9999px; font-size: 13px; font-weight: 700;">daria_art</div>
            </div>
            <div class="glass-panel" style="background: #10B981; border-radius: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; border: none;">
              <div style="width: 80px; height: 80px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 900;">M</div>
              <div style="position: absolute; bottom: 16px; background: rgba(9,9,11,0.8); padding: 6px 16px; border-radius: 9999px; font-size: 13px; font-weight: 700;">misha</div>
            </div>
          </div>
        </div>
      </div>
      ${DOCK_HTML}
    </body></html>
  `,

  '05_voice_room_with_screenshare': `
    <!DOCTYPE html><html><head><style>${COMMON_CSS}</style></head>
    <body>
      ${TITLEBAR_HTML}
      <div style="display: flex; width: 100vw; height: 100vh; position: relative;">
        ${SIDEBAR_HTML('channels')}

        <div style="flex: 1; margin-top: 48px; padding: 20px; display: flex; flex-direction: column; position: relative; gap: 16px;">
          <div class="glass-panel" style="flex: 1; border-radius: 20px; background: #000; overflow: hidden; position: relative; display: flex; align-items: center; justify-content: center; border: 1px solid rgba(255,255,255,0.1);">
            <div style="width: 100%; height: 100%; background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%); display: flex; flex-direction: column; align-items: center; justify-content: center;">
              <svg class="icon" style="width: 64px; height: 64px; color: rgb(var(--z-primary)); margin-bottom: 16px;" viewBox="0 0 256 256"><path d="M216,40H40A16,16,0,0,0,24,56V168a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Z"/></svg>
              <span style="font-size: 18px; font-weight: 800; color: #fff;">трансляция alex_pro</span>
              <span style="font-size: 12px; color: rgba(255,255,255,0.4); margin-top: 4px;">1920x1080 • 60 FPS • Direct P2P</span>
            </div>
            <div style="position: absolute; top: 16px; left: 16px; background: rgba(9,9,11,0.8); padding: 6px 14px; border-radius: 9999px; font-size: 12px; font-weight: 700; border: 1px solid rgba(255,255,255,0.1);">
              ● в эфире (alex_pro)
            </div>
            <div style="position: absolute; top: 16px; right: 16px; background: rgb(var(--z-primary)); padding: 4px 10px; border-radius: 8px; font-size: 11px; font-weight: 800;">
              60 FPS
            </div>
          </div>

          <div style="height: 90px; display: flex; gap: 12px; justify-content: center; margin-bottom: 70px;">
            <div style="width: 80px; border-radius: 16px; background: #8B5CF6; display: flex; flex-direction: column; align-items: center; justify-content: center;">
              <div style="width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-weight: 800;">V</div>
              <span style="font-size: 11px; font-weight: 700; margin-top: 4px;">вы</span>
            </div>
            <div style="width: 80px; border-radius: 16px; background: #3B82F6; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 2px solid #23A559;">
              <div style="width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-weight: 800;">A</div>
              <span style="font-size: 11px; font-weight: 700; margin-top: 4px;">alex_pro</span>
            </div>
            <div style="width: 80px; border-radius: 16px; background: #EC4899; display: flex; flex-direction: column; align-items: center; justify-content: center;">
              <div style="width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-weight: 800;">D</div>
              <span style="font-size: 11px; font-weight: 700; margin-top: 4px;">daria</span>
            </div>
          </div>
        </div>
      </div>
      ${DOCK_HTML}
    </body></html>
  `,

  '06_friends_tab_list': `
    <!DOCTYPE html><html><head><style>${COMMON_CSS}</style></head>
    <body>
      ${TITLEBAR_HTML}
      <div style="display: flex; width: 100vw; height: 100vh; position: relative;">
        ${SIDEBAR_HTML('friends')}
        <div style="flex: 1; margin-top: 48px; padding: 32px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;">
          <div style="width: 64px; height: 64px; border-radius: 20px; background: rgba(255,255,255,0.04); display: flex; align-items: center; justify-content: center; margin-bottom: 16px;">
            <svg class="icon" style="width: 32px; height: 32px; color: rgba(255,255,255,0.3);" viewBox="0 0 256 256"><path d="M216,40H40A16,16,0,0,0,24,56V168a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Z"/></svg>
          </div>
          <h2 style="font-size: 18px; font-weight: 800; margin-bottom: 8px;">выберите друга или канал</h2>
          <p style="font-size: 13px; color: rgba(255,255,255,0.4); max-width: 340px;">звоните напрямую через P2P mesh или общайтесь в защищенных комнатах</p>
        </div>
      </div>
    </body></html>
  `,

  // MODALS
  '01_settings_general': `
    <!DOCTYPE html><html><head><style>${COMMON_CSS}</style></head>
    <body>
      ${TITLEBAR_HTML}
      <div style="width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.6);">
        <div class="glass-modal" style="width: 520px; padding: 28px; display: flex; flex-direction: column; gap: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h2 style="font-size: 20px; font-weight: 900;">настройки</h2>
            <div style="color: rgba(255,255,255,0.4); cursor: pointer;">✕</div>
          </div>
          <div style="display: flex; gap: 8px; background: rgba(255,255,255,0.03); padding: 4px; border-radius: 14px;">
            <div style="flex: 1; text-align: center; padding: 8px; border-radius: 10px; font-size: 13px; font-weight: 700; background: rgb(var(--z-primary)); color: #fff;">общие</div>
            <div style="flex: 1; text-align: center; padding: 8px; border-radius: 10px; font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.5);">звук</div>
            <div style="flex: 1; text-align: center; padding: 8px; border-radius: 10px; font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.5);">безопасность</div>
          </div>
          <div style="display: flex; flex-direction: column; gap: 14px;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: rgba(255,255,255,0.03); border-radius: 12px;">
              <div>
                <div style="font-size: 13px; font-weight: 700;">запускать вместе с Windows</div>
                <div style="font-size: 11px; color: rgba(255,255,255,0.4);">zabor откроется автоматически при включении ПК</div>
              </div>
              <div style="width: 44px; height: 24px; border-radius: 12px; background: rgb(var(--z-primary)); position: relative;">
                <div style="width: 20px; height: 20px; border-radius: 50%; background: #fff; position: absolute; right: 2px; top: 2px;"></div>
              </div>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: rgba(255,255,255,0.03); border-radius: 12px;">
              <div>
                <div style="font-size: 13px; font-weight: 700;">сворачивать в трей</div>
                <div style="font-size: 11px; color: rgba(255,255,255,0.4);">при нажатии на крестик окно свернется</div>
              </div>
              <div style="width: 44px; height: 24px; border-radius: 12px; background: rgb(var(--z-primary)); position: relative;">
                <div style="width: 20px; height: 20px; border-radius: 50%; background: #fff; position: absolute; right: 2px; top: 2px;"></div>
              </div>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: rgba(255,255,255,0.03); border-radius: 12px;">
              <div>
                <div style="font-size: 13px; font-weight: 700;">обновления приложения</div>
                <div style="font-size: 11px; color: #23A559;">у вас установлена актуальная версия v3.5.3</div>
              </div>
              <button class="btn-surface" style="padding: 8px 14px; font-size: 11px;">проверить</button>
            </div>
          </div>
        </div>
      </div>
    </body></html>
  `,

  '02_settings_audio_smart': `
    <!DOCTYPE html><html><head><style>${COMMON_CSS}</style></head>
    <body>
      ${TITLEBAR_HTML}
      <div style="width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.6);">
        <div class="glass-modal" style="width: 540px; padding: 28px; display: flex; flex-direction: column; gap: 18px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h2 style="font-size: 20px; font-weight: 900;">настройки звука</h2>
            <div style="color: rgba(255,255,255,0.4); cursor: pointer;">✕</div>
          </div>
          <div style="display: flex; gap: 8px; background: rgba(255,255,255,0.03); padding: 4px; border-radius: 14px;">
            <div style="flex: 1; text-align: center; padding: 8px; border-radius: 10px; font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.5);">общие</div>
            <div style="flex: 1; text-align: center; padding: 8px; border-radius: 10px; font-size: 13px; font-weight: 700; background: rgb(var(--z-primary)); color: #fff;">звук</div>
            <div style="flex: 1; text-align: center; padding: 8px; border-radius: 10px; font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.5);">безопасность</div>
          </div>
          <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px; background: rgba(200,30,112,0.1); border: 1px solid rgba(200,30,112,0.3); border-radius: 14px;">
            <div>
              <div style="font-size: 13px; font-weight: 800; color: rgb(var(--z-primary-text));">умное шумоподавление (Silero VAD + DeepFilter)</div>
              <div style="font-size: 11px; color: rgba(255,255,255,0.6); margin-top: 2px;">нейросеть отделяет речь от шума кулеров и клавиатуры</div>
            </div>
            <div style="background: rgb(var(--z-primary)); padding: 4px 10px; border-radius: 8px; font-size: 11px; font-weight: 800;">умное</div>
          </div>
          <div style="background: rgba(255,255,255,0.03); border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <div style="font-size: 13px; font-weight: 700;">калибровка микрофона</div>
                <div style="font-size: 11px; color: rgba(255,255,255,0.4);">подбор уверенности Silero под ваш голос</div>
              </div>
              <button class="btn-primary" style="padding: 8px 16px; font-size: 12px;">калибровка</button>
            </div>
            <div style="font-size: 12px; color: rgb(var(--z-primary-text)); font-style: italic; background: rgba(200,30,112,0.08); padding: 8px 12px; border-radius: 8px;">
              фраза: «съешь ещё этих мягких французских булок»
            </div>
          </div>
          <div style="background: rgba(255,255,255,0.03); border-radius: 14px; padding: 14px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <span style="font-size: 13px; font-weight: 700;">послушать себя</span>
              <span style="font-size: 11px; color: #23A559; font-weight: 700;">00:03 / 00:05</span>
            </div>
            <div style="display: flex; align-items: center; gap: 3px; height: 32px; padding: 4px 0;">
              ${Array.from({length: 36}).map((_, i) => `<div style="flex: 1; height: ${Math.max(15, Math.sin(i*0.4)*100)}%; background: ${i < 20 ? 'rgb(var(--z-primary))' : 'rgba(255,255,255,0.15)'}; border-radius: 4px;"></div>`).join('')}
            </div>
          </div>
        </div>
      </div>
    </body></html>
  `,

  '03_settings_privacy_ip_masking': `
    <!DOCTYPE html><html><head><style>${COMMON_CSS}</style></head>
    <body>
      ${TITLEBAR_HTML}
      <div style="width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.6);">
        <div class="glass-modal" style="width: 520px; padding: 28px; display: flex; flex-direction: column; gap: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h2 style="font-size: 20px; font-weight: 900;">безопасность</h2>
            <div style="color: rgba(255,255,255,0.4); cursor: pointer;">✕</div>
          </div>
          <div style="display: flex; gap: 8px; background: rgba(255,255,255,0.03); padding: 4px; border-radius: 14px;">
            <div style="flex: 1; text-align: center; padding: 8px; border-radius: 10px; font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.5);">общие</div>
            <div style="flex: 1; text-align: center; padding: 8px; border-radius: 10px; font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.5);">звук</div>
            <div style="flex: 1; text-align: center; padding: 8px; border-radius: 10px; font-size: 13px; font-weight: 700; background: rgb(var(--z-primary)); color: #fff;">безопасность</div>
          </div>
          <div style="background: rgba(200,30,112,0.1); border: 1px solid rgba(200,30,112,0.3); border-radius: 16px; padding: 18px; display: flex; flex-direction: column; gap: 10px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div style="font-size: 14px; font-weight: 800; color: #fff;">скрывать мой IP-адрес</div>
              <div style="width: 44px; height: 24px; border-radius: 12px; background: rgb(var(--z-primary)); position: relative;">
                <div style="width: 20px; height: 20px; border-radius: 50%; background: #fff; position: absolute; right: 2px; top: 2px;"></div>
              </div>
            </div>
            <p style="font-size: 12px; line-height: 1.5; color: rgba(255,255,255,0.6);">
              весь голос идёт через сервер ретрансляции, собеседники не видят ваш реальный IP. задержка чуть выше.
            </p>
          </div>
        </div>
      </div>
    </body></html>
  `,

  '04_stream_picker_source_modal': `
    <!DOCTYPE html><html><head><style>${COMMON_CSS}</style></head>
    <body>
      ${TITLEBAR_HTML}
      <div style="width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.6);">
        <div class="glass-modal" style="width: 560px; padding: 28px; display: flex; flex-direction: column; gap: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h2 style="font-size: 20px; font-weight: 900;">выбор источника</h2>
            <div style="color: rgba(255,255,255,0.4); cursor: pointer;">✕</div>
          </div>
          <div style="display: flex; gap: 8px; background: rgba(255,255,255,0.03); padding: 4px; border-radius: 14px;">
            <div style="flex: 1; text-align: center; padding: 8px; border-radius: 10px; font-size: 13px; font-weight: 700; background: rgb(var(--z-primary)); color: #fff;">экраны</div>
            <div style="flex: 1; text-align: center; padding: 8px; border-radius: 10px; font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.5);">приложения</div>
            <div style="flex: 1; text-align: center; padding: 8px; border-radius: 10px; font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.5);">камеры</div>
          </div>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px;">
            <div style="background: rgba(200,30,112,0.12); border: 2px solid rgb(var(--z-primary)); border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 8px;">
              <div style="height: 100px; background: #1a1a24; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                <svg class="icon" style="width: 40px; height: 40px; color: rgb(var(--z-primary));" viewBox="0 0 256 256"><path d="M216,40H40A16,16,0,0,0,24,56V168a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Z"/></svg>
              </div>
              <div style="font-size: 13px; font-weight: 700; color: #fff;">экран 1 (основной)</div>
              <div style="font-size: 11px; color: rgba(255,255,255,0.4);">1920x1080 • 144Hz</div>
            </div>
            <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 8px;">
              <div style="height: 100px; background: #18181b; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                <svg class="icon" style="width: 40px; height: 40px; color: rgba(255,255,255,0.3);" viewBox="0 0 256 256"><path d="M216,40H40A16,16,0,0,0,24,56V168a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Z"/></svg>
              </div>
              <div style="font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.7);">экран 2</div>
              <div style="font-size: 11px; color: rgba(255,255,255,0.4);">1920x1080 • 60Hz</div>
            </div>
          </div>
          <button class="btn-primary" style="width: 100%; padding: 14px; font-size: 14px;">поехали</button>
        </div>
      </div>
    </body></html>
  `,

  '05_achievements_system_modal': `
    <!DOCTYPE html><html><head><style>${COMMON_CSS}</style></head>
    <body>
      ${TITLEBAR_HTML}
      <div style="width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.6);">
        <div class="glass-modal" style="width: 560px; padding: 28px; display: flex; flex-direction: column; gap: 18px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <h2 style="font-size: 20px; font-weight: 900;">достижения</h2>
              <div style="font-size: 12px; color: rgb(var(--z-primary-text)); font-weight: 700; margin-top: 2px;">7 / 25 получено</div>
            </div>
            <div style="color: rgba(255,255,255,0.4); cursor: pointer;">✕</div>
          </div>
          <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 9999px; overflow: hidden;">
            <div style="width: 28%; height: 100%; background: rgb(var(--z-primary));"></div>
          </div>
          <div style="display: flex; flex-direction: column; gap: 10px;">
            <div style="background: rgba(200,30,112,0.12); border: 1px solid rgba(200,30,112,0.3); border-radius: 14px; padding: 12px 14px; display: flex; align-items: center; gap: 14px;">
              <div style="width: 44px; height: 44px; border-radius: 12px; background: rgb(var(--z-primary)); display: flex; align-items: center; justify-content: center; font-size: 20px;">🏆</div>
              <div style="flex: 1;">
                <div style="font-size: 14px; font-weight: 800; color: #fff;">душнее душнилы</div>
                <div style="font-size: 11px; color: rgba(255,255,255,0.6);">задолбать даже админа</div>
              </div>
              <span style="font-size: 11px; color: #23A559; font-weight: 800;">✓ получено</span>
            </div>
            <div style="background: rgba(200,30,112,0.12); border: 1px solid rgba(200,30,112,0.3); border-radius: 14px; padding: 12px 14px; display: flex; align-items: center; gap: 14px;">
              <div style="width: 44px; height: 44px; border-radius: 12px; background: #3B82F6; display: flex; align-items: center; justify-content: center; font-size: 20px;">🦉</div>
              <div style="flex: 1;">
                <div style="font-size: 14px; font-weight: 800; color: #fff;">ночная сова</div>
                <div style="font-size: 11px; color: rgba(255,255,255,0.6);">начать звонок после 2:00 ночи</div>
              </div>
              <span style="font-size: 11px; color: #23A559; font-weight: 800;">✓ получено</span>
            </div>
          </div>
        </div>
      </div>
    </body></html>
  `,

  // ISOLATED ELEMENTS
  '01_titlebar': `
    <!DOCTYPE html><html class="transparent-bg"><head><style>${COMMON_CSS} body { display: flex; flex-direction: column; background: transparent; }</style></head>
    <body>
      ${TITLEBAR_HTML}
    </body></html>
  `,

  '02_floating_call_dock': `
    <!DOCTYPE html><html class="transparent-bg"><head><style>${COMMON_CSS} body { display: flex; align-items: center; justify-content: center; height: 100vh; background: transparent; }</style></head>
    <body>
      <div style="position: relative;">
        ${DOCK_HTML.replace('position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);', 'position: relative;')}
      </div>
    </body></html>
  `,

  '03_left_sidebar_channels': `
    <!DOCTYPE html><html class="transparent-bg"><head><style>${COMMON_CSS} body { display: flex; align-items: center; justify-content: center; height: 100vh; background: transparent; }</style></head>
    <body>
      <div style="position: relative;">
        ${SIDEBAR_HTML('channels').replace('margin-top: 48px; margin-left: 12px;', '')}
      </div>
    </body></html>
  `,

  '04_left_sidebar_friends': `
    <!DOCTYPE html><html class="transparent-bg"><head><style>${COMMON_CSS} body { display: flex; align-items: center; justify-content: center; height: 100vh; background: transparent; }</style></head>
    <body>
      <div style="position: relative;">
        ${SIDEBAR_HTML('friends').replace('margin-top: 48px; margin-left: 12px;', '')}
      </div>
    </body></html>
  `,

  '05_user_profile_slab': `
    <!DOCTYPE html><html class="transparent-bg"><head><style>${COMMON_CSS} body { display: flex; align-items: center; justify-content: center; height: 100vh; background: transparent; }</style></head>
    <body>
      <div class="glass-slab" style="width: 280px; padding: 12px 14px; border-radius: 16px; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <div style="width: 38px; height: 38px; border-radius: 50%; background: #8B5CF6; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 15px; color: #fff;">V</div>
          <div>
            <div style="font-size: 13px; font-weight: 700; color: #fff;">vnkdevelop</div>
            <div style="font-size: 10px; color: rgba(255,255,255,0.4);">нажмите, чтобы скопировать</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <div style="width: 30px; height: 30px; border-radius: 8px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.7); cursor: pointer;">
            <svg class="icon" style="width: 14px; height: 14px;" viewBox="0 0 256 256"><path d="M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176Z"/></svg>
          </div>
          <div style="width: 30px; height: 30px; border-radius: 8px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.7); cursor: pointer;">
            <svg class="icon" style="width: 14px; height: 14px;" viewBox="0 0 256 256"><path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Z"/></svg>
          </div>
        </div>
      </div>
    </body></html>
  `,

  '06_voice_user_card_speaking': `
    <!DOCTYPE html><html class="transparent-bg"><head><style>${COMMON_CSS} body { display: flex; align-items: center; justify-content: center; height: 100vh; background: transparent; }</style></head>
    <body>
      <div class="glass-panel" style="width: 380px; height: 260px; background: #8B5CF6; border-radius: 28px; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; border: 3px solid #23A559; box-shadow: 0 0 35px rgba(35, 165, 89, 0.45);">
        <div style="width: 96px; height: 96px; border-radius: 50%; background: rgba(255,255,255,0.25); display: flex; align-items: center; justify-content: center; font-size: 38px; font-weight: 900; color: #fff;">V</div>
        <div style="position: absolute; bottom: 20px; background: #23A559; color: #fff; padding: 8px 20px; border-radius: 9999px; font-size: 14px; font-weight: 800;">
          vnkdevelop • говорит
        </div>
      </div>
    </body></html>
  `,

  '07_toast_achievement_unlocked': `
    <!DOCTYPE html><html class="transparent-bg"><head><style>${COMMON_CSS} body { display: flex; align-items: center; justify-content: center; height: 100vh; background: transparent; }</style></head>
    <body>
      <div class="glass-sheet" style="padding: 16px 22px; border-radius: 18px; background: rgba(22, 22, 24, 0.95); display: flex; align-items: center; gap: 16px; border: 1px solid rgba(200,30,112,0.4);">
        <div style="width: 48px; height: 48px; border-radius: 14px; background: rgb(var(--z-primary)); display: flex; align-items: center; justify-content: center; font-size: 24px;">🏆</div>
        <div>
          <div style="font-size: 11px; font-weight: 800; letter-spacing: 0.1em; color: rgb(var(--z-primary-text));">достижение получено!</div>
          <div style="font-size: 15px; font-weight: 800; color: #fff; margin-top: 2px;">душнее душнилы</div>
          <div style="font-size: 12px; color: rgba(255,255,255,0.5);">задолбать даже админа</div>
        </div>
      </div>
    </body></html>
  `,

  '08_context_menu_user': `
    <!DOCTYPE html><html class="transparent-bg"><head><style>${COMMON_CSS} body { display: flex; align-items: center; justify-content: center; height: 100vh; background: transparent; }</style></head>
    <body>
      <div class="glass-sheet" style="width: 220px; padding: 8px; border-radius: 16px; background: rgba(22,22,24,0.95); display: flex; flex-direction: column; gap: 4px;">
        <div style="padding: 10px 14px; border-radius: 10px; font-size: 13px; font-weight: 600; color: #fff; cursor: pointer; display: flex; align-items: center; gap: 10px; background: rgba(255,255,255,0.06);">
          <svg class="icon" style="width: 16px; height: 16px;" viewBox="0 0 256 256"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Z"/></svg>
          <span>профиль</span>
        </div>
        <div style="padding: 10px 14px; border-radius: 10px; font-size: 13px; font-weight: 600; color: #fff; cursor: pointer; display: flex; align-items: center; gap: 10px;">
          <svg class="icon" style="width: 16px; height: 16px;" viewBox="0 0 256 256"><path d="M152,120H136V56h16a8,8,0,0,0,0-16H104a8,8,0,0,0,0,16h16v64H104a8,8,0,0,0,0,16h48a8,8,0,0,0,0-16Z"/></svg>
          <span>позвать в канал</span>
        </div>
        <div style="padding: 10px 14px; border-radius: 10px; font-size: 13px; font-weight: 600; color: #fff; cursor: pointer; display: flex; align-items: center; gap: 10px;">
          <svg class="icon" style="width: 16px; height: 16px;" viewBox="0 0 256 256"><path d="M152,40V216a8,8,0,0,1-13.66,5.66L82.34,166H40a16,16,0,0,1-16-16V106A16,16,0,0,1,40,90H82.34l56-55.66A8,8,0,0,1,152,40Z"/></svg>
          <span>громкость</span>
        </div>
        <div style="height: 1px; background: rgba(255,255,255,0.08); margin: 4px 0;"></div>
        <div style="padding: 10px 14px; border-radius: 10px; font-size: 13px; font-weight: 600; color: #DA373C; cursor: pointer; display: flex; align-items: center; gap: 10px;">
          <svg class="icon" style="width: 16px; height: 16px;" viewBox="0 0 256 256"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16Z"/></svg>
          <span>исключить</span>
        </div>
      </div>
    </body></html>
  `,

  '09_silero_calibration_widget': `
    <!DOCTYPE html><html class="transparent-bg"><head><style>${COMMON_CSS} body { display: flex; align-items: center; justify-content: center; height: 100vh; background: transparent; }</style></head>
    <body>
      <div class="glass-sheet" style="padding: 20px 28px; border-radius: 20px; background: rgba(22, 22, 24, 0.95); display: flex; flex-direction: column; gap: 10px; border: 1px solid rgba(200,30,112,0.4); max-width: 480px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <div style="width: 10px; height: 10px; border-radius: 50%; background: rgb(var(--z-primary)); box-shadow: 0 0 10px rgb(var(--z-primary));"></div>
          <span style="font-size: 12px; font-weight: 800; color: rgb(var(--z-primary-text)); letter-spacing: 0.05em;">калибровка микрофона silero vad</span>
        </div>
        <div style="font-size: 16px; font-weight: 800; color: #fff; line-height: 1.4;">
          «съешь ещё этих мягких французских булок»
        </div>
        <div style="font-size: 12px; color: rgba(255,255,255,0.4);">
          произнесите фразу обычным голосом для точной настройки порога
        </div>
      </div>
    </body></html>
  `
};

const server = http.createServer((req, res) => {
  const pageKey = req.url.replace(/^\//, '');
  if (PAGES[pageKey]) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGES[pageKey]);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

async function main() {
  await new Promise(r => server.listen(48938, r));
  console.log('HTTP render server on port 48938');

  console.log('Launching headless Edge with CDP...');
  const edgeProc = spawn(EDGE_PATH, [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=9222',
    `--user-data-dir=${TEMP_USER_DATA}`,
    '--window-size=1920,1080',
    'about:blank'
  ], { stdio: 'ignore' });

  async function getWsUrl() {
    for (let i = 0; i < 25; i++) {
      try {
        const data = await new Promise((resolve, reject) => {
          http.get('http://localhost:9222/json/list', (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => resolve(JSON.parse(buf)));
          }).on('error', reject);
        });
        const page = data.find(p => p.type === 'page' && p.url === 'about:blank');
        if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('CDP page not found');
  }

  const wsUrl = await getWsUrl();
  console.log('Connected to CDP target:', wsUrl);
  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.onopen = r);

  let msgId = 1;
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = msgId++;
    const handler = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 2,
    mobile: false
  });

  const entries = Object.keys(PAGES);
  console.log(`Starting high-speed capture of ${entries.length} assets...`);

  for (let i = 0; i < entries.length; i++) {
    const name = entries[i];
    let outFolder = DIRS.full;
    const isIsolated = name.startsWith('01_titlebar') || name.startsWith('02_floating') || name.startsWith('03_left') || name.startsWith('04_left') || name.startsWith('05_user') || name.startsWith('06_voice') || name.startsWith('07_toast') || name.startsWith('08_context') || name.startsWith('09_silero');
    
    if (isIsolated) {
      outFolder = DIRS.isolated;
    } else if (name.startsWith('01_settings') || name.startsWith('02_settings') || name.startsWith('03_settings') || name.startsWith('04_stream') || name.startsWith('05_achieve')) {
      outFolder = DIRS.modals;
    }

    const outPath = path.join(outFolder, `${name}.png`);
    process.stdout.write(`[${i + 1}/${entries.length}] Capturing ${name}... `);

    // If isolated element, set transparent background
    if (isIsolated) {
      await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    } else {
      await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 19, g: 19, b: 19, a: 1 } });
    }

    await send('Page.navigate', { url: `http://localhost:48938/${name}` });
    await new Promise(r => setTimeout(r, 120));

    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));

    const sz = fs.statSync(outPath).size;
    console.log(`✓ (${(sz / 1024).toFixed(1)} KB)`);
  }

  // Create Manifest README
  const README_CONTENT = `# Zabor Promo Video Assets Manifest

Сгенерированные скриншоты интерфейса и изолированных элементов в сверхвысоком разрешении (Hi-DPI 4K @ 2x = 3840x2160) для After Effects и Cinema 4D.

## Структура папок:

### 1. 01_full_screens/ (Полноэкранные кадры интерфейса 1920x1080 @ 2x = 3840x2160)
- \`01_login_screen.png\` — Экран входа в аккаунт с фирменным брендингом zabor и неоновым свечением.
- \`02_create_profile_crop.png\` — Экран создания профиля и обрезки аватара.
- \`03_voice_room_idle.png\` — Основной экран голосового канала в состоянии покоя (сетка участников, боковая панель, док).
- \`04_voice_room_speaking_active.png\` — Голосовой канал во время речи с активным зеленым/маджента индикатором Silero VAD.
- \`05_voice_room_with_screenshare.png\` — Демонстрация экрана 60 FPS в центре сцены с участниками внизу.
- \`06_friends_tab_list.png\` — Экран вкладки друзей с онлайн/офлайн статусами.

### 2. 02_isolated_elements/ (Изолированные элементы на прозрачном фоне PNG)
- \`01_titlebar.png\` — Безрамочный кастомный тайтлбар с логотипом zabor и кнопками окна.
- \`02_floating_call_dock.png\` — Плавающий нижний остров управления звонком (микрофон, наушники, трансляция, завершить).
- \`03_left_sidebar_channels.png\` — Боковая стеклянная панель со списком каналов и плашкой профиля.
- \`04_left_sidebar_friends.png\` — Боковая стеклянная панель со списком друзей.
- \`05_user_profile_slab.png\` — Нижняя стеклянная плашка профиля текущего пользователя.
- \`06_voice_user_card_speaking.png\` — Карточка говорящего участника с неоновым ореолом.
- \`07_toast_achievement_unlocked.png\` — Всплывающее уведомление о получении ачивки («душнее душнилы»).
- \`08_context_menu_user.png\` — Стеклянное контекстное меню действий пользователя.
- \`09_silero_calibration_widget.png\` — Виджет калибровки голоса («съешь ещё этих мягких французских булок»).

### 3. 03_features_and_modals/ (Модальные окна настроек и функционала)
- \`01_settings_general.png\` — Настройки: вкладка «общие» (автозапуск, трей, язык, обновления).
- \`02_settings_audio_smart.png\` — Настройки: вкладка «звук» (Silero VAD, DeepFilter, калибровка, плеер волны).
- \`03_settings_privacy_ip_masking.png\` — Настройки: вкладка «безопасность» (тумблер защиты и скрытия IP).
- \`04_stream_picker_source_modal.png\` — Выбор источника трансляции (экраны, приложения, камеры, 60fps).
- \`05_achievements_system_modal.png\` — Экран системы достижений со списком бейджей и прогресс-баром.

---
Сгенерировано автоматически. 100% точность дизайн-системы Zabor (Strict Lowercase, Deep Dark, Neon Magenta, Glassmorphism).
`;

  fs.writeFileSync(path.join(BASE_OUT, 'README.md'), README_CONTENT, 'utf8');
  console.log('Manifest README.md created.');

  ws.close();
  edgeProc.kill();
  try { fs.rmSync(TEMP_USER_DATA, { recursive: true, force: true }); } catch (e) {}
  server.close(() => {
    console.log('All screenshots generated and saved successfully!');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
