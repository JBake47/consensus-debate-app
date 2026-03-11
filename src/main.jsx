import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DebateProvider } from './context/DebateContext';
import App from './App';
import { applyThemeMode, getStoredThemeMode } from './lib/theme';
import './theme.css';

applyThemeMode(getStoredThemeMode());

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DebateProvider>
      <App />
    </DebateProvider>
  </StrictMode>
);
