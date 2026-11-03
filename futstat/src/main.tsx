import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { installGlobalErrorHandlers, reportError } from './app/lib/errors';
import './fonts.css';
import './index.css';

// Antes de nada: errores fuera de React (temporizadores, promesas, chunks) nunca tumban la interfaz.
installGlobalErrorHandlers();

// Respaldo del script de tema de index.html (por si la CSP lo bloqueara): aplica el tema guardado.
try {
  const saved = window.localStorage.getItem('futstat-theme');
  if ((saved === 'light' || saved === 'dark') && document.documentElement.getAttribute('data-theme') !== saved) {
    document.documentElement.setAttribute('data-theme', saved);
    document.documentElement.style.colorScheme = saved;
  }
} catch {
  /* almacenamiento no disponible: tema oscuro por defecto */
}

/** Último recurso si React no puede arrancar: mensaje estático (solo textContent, nada de HTML inyectado). */
function renderStaticFallback(root: HTMLElement) {
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = 'max-width:28rem;margin:15vh auto;padding:24px;font-family:system-ui,sans-serif;text-align:center;color:#eef2f6;background:#10151c;border:1px solid #242c38;border-radius:14px';
  const title = document.createElement('p');
  title.style.cssText = 'font-size:20px;font-weight:700;margin:0 0 8px';
  title.textContent = 'FutStat Lab no ha podido arrancar';
  const msg = document.createElement('p');
  msg.style.cssText = 'font-size:14px;color:#aab4c0;margin:0 0 16px';
  msg.textContent = 'Recarga la página. Si el problema continúa, vuelve a intentarlo en unos minutos.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Recargar';
  btn.style.cssText = 'padding:8px 16px;border-radius:8px;border:0;background:#c6f135;color:#0b0f14;font-weight:600;cursor:pointer';
  btn.addEventListener('click', () => window.location.reload());
  box.append(title, msg, btn);
  root.replaceChildren(box);
}

const root = document.getElementById('root');
if (root) {
  try {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (e) {
    reportError('Arranque', e);
    renderStaticFallback(root);
  }
}
