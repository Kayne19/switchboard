import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DebugApp } from './App';
// The main page's stylesheet first: its tokens, type and primitives. The
// debug page's own rules lay those out and add only what the main page lacks.
import '../styles/index.css';
import './debug.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DebugApp />
  </StrictMode>,
);
