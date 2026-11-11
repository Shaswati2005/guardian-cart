import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { Theme } from '@astryxdesign/core/theme';
import { matchaTheme } from '@astryxdesign/theme-matcha/built';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Light only for now: the AG Grid ledger and PayPal colors aren't tuned for dark mode yet */}
    <Theme theme={matchaTheme} mode="light">
      <App />
    </Theme>
  </StrictMode>
);
