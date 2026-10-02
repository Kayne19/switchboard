import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DebugApp } from './App';
import './debug.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DebugApp />
  </StrictMode>,
);
