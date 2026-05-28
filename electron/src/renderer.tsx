import React from 'react';
import { createRoot } from 'react-dom/client';
import './globals.css';

function App() {
  return (
    <div className="flex h-full items-center justify-center bg-background text-foreground">
      <p className="text-lg font-medium">Nanobot — 渲染层就绪</p>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('No #root element found');
createRoot(root).render(<App />);
