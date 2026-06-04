import React from 'react';
import { createRoot } from 'react-dom/client';
import { HotkeysProvider } from '@tanstack/react-hotkeys';
import './globals.css';
// Init i18n (side-effects: sets document.lang, reads localStorage locale)
import '@/i18n';
import App from '@/App';

const root = document.getElementById('root');
if (!root) throw new Error('No #root element found');
createRoot(root).render(
  <HotkeysProvider>
    <App />
  </HotkeysProvider>,
);
