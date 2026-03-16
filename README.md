# ZABOR

Десктопное приложение для голосового общения.

## 🛠 Стек

- **Клиент:** React 18, TypeScript, Tailwind CSS, Electron
- **Сервер:** C# ASP.NET Core 8, SignalR
- **Голос:** WebRTC (P2P, Mesh), RNNoise ML-шумоподавление

## 📥 Установка

Скачайте последнюю версию со страницы [Releases](https://github.com/poradaise2009-beep/zabor-desktop/releases).

> ⚠️ **Windows SmartScreen** может показать предупреждение при первом запуске.
> Это происходит со всеми новыми приложениями без цифровой подписи.
>
> **Как установить:**
> 1. Нажмите **«Подробнее»** (More info)
> 2. Нажмите **«Выполнить в любом случае»** (Run anyway)

## 🚀 Разработка

```bash
# Установка зависимостей
npm install

# Сборка установщика
npm run dist:win