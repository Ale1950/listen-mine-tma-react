import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/arctic.css';

declare global {
  interface Window {
    Telegram?: { WebApp?: any };
  }
}

if (window.Telegram?.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
  window.Telegram.WebApp.setHeaderColor?.('#060a12');
  window.Telegram.WebApp.setBackgroundColor?.('#060a12');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
